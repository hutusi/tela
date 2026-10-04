/**
 * A reader asking for an article's body in their language (ADR 0023): an RPC, because the reader
 * needs the answer. The work itself is state: a `requested` row the jobs Worker translates in
 * streamed chunks. This route also claims it and sends it on at once, so the first chunk does not
 * wait for the next minute's sweep.
 */
import {
  bumpSeq,
  claimDue,
  consumeLimit,
  currentSeq,
  dueBodies,
  first,
  loadBodyTranslation,
  TRANSLATE_BODY_TTL_MS,
  utcDay,
} from '@tela/data'
import {
  isReadingLanguage,
  MAX_ARTICLE_TRANSLATION_TOKENS,
  USER_DAILY_TRANSLATION_TOKENS,
} from '@tela/shared'
import { sql } from 'drizzle-orm'
import { Hono } from 'hono'
import type { ApiEnv } from '../app'
import type { ApiDeps } from '../deps'

export type TranslationRequestStatus =
  | 'requested'
  | 'in_progress'
  | 'ready'
  | 'invalid'
  | 'unavailable'
  | 'rate_limited'
  | 'budget_exhausted'

const CJK_SOURCE = /^(zh|ja|ko)\b/
const CHINESE_SCRIPTS: readonly (string | null)[] = ['zh-Hans', 'zh-Hant']

/**
 * A post in one Chinese script read in the other: tela-jobs converts it with OpenCC and asks no
 * model (`scriptConversion` in @tela/llm, which tela-api does not import: it would bundle OpenCC's
 * dictionaries for one comparison). Nothing is spent, so nothing is reserved.
 */
export function isScriptConversion(sourceLang: string | null, lang: string): boolean {
  return (
    sourceLang !== lang && CHINESE_SCRIPTS.includes(sourceLang) && CHINESE_SCRIPTS.includes(lang)
  )
}

/**
 * Tokens to reserve against the member's day. The reservation is also the job's ceiling on
 * source tokens, so it leans high: a low guess would cut the translation short, while a high one
 * is given back when the job reconciles what it really spent.
 */
export function reservationFor(bodyChars: number, sourceLang: string | null): number {
  const guess = CJK_SOURCE.test(sourceLang ?? '') ? bodyChars : Math.ceil(bodyChars / 4)
  return Math.min(MAX_ARTICLE_TRANSLATION_TOKENS, Math.ceil(guess * 1.5) + 500)
}

type Row = Awaited<ReturnType<typeof loadBodyTranslation>>

/** What the reader sees of a translation: never who asked or what it cost. */
const view = (row: NonNullable<Row>) => ({
  contentKey: row.contentKey,
  lang: row.lang,
  state: row.state,
  chunkKeys: row.chunkKeys,
  objectKey: row.objectKey,
  failedLeaves: row.failedLeaves,
})

export function translationRoutes(deps: ApiDeps) {
  const { db } = deps
  const routes = new Hono<ApiEnv>()

  routes.post('/', async (c) => {
    const member = c.get('member')
    const body = await c.req
      .json<{ articleId?: unknown; lang?: unknown }>()
      .catch(() => ({}) as Record<string, unknown>)
    const articleId = Number(body.articleId)
    const lang = body.lang
    const answer = (status: TranslationRequestStatus, row?: Row, code = 200) =>
      c.json({ status, translation: row ? view(row) : null }, code as 200)
    if (!Number.isInteger(articleId) || !isReadingLanguage(lang))
      return answer('invalid', null, 400)

    const article = await first<{
      content_key: string | null
      source_lang: string | null
      opt_out: number
      body_chars: number | null
    }>(
      db,
      sql`
        select a.content_key, a.source_lang, s.translation_opt_out as opt_out, v.body_chars
        from articles a join feeds f on f.id = a.feed_id join sites s on s.id = f.site_id
        left join article_versions v on v.article_id = a.id and v.version = a.current_version
        where a.id = ${articleId}
      `,
    )
    if (!article) return c.json({ error: 'not_found' }, 404)
    // A blog that opted out is refused before anything is counted or reserved.
    if (article.opt_out || !article.content_key) return answer('unavailable')
    if (article.source_lang === lang) return answer('invalid')
    const contentKey = article.content_key

    const existing = await loadBodyTranslation(db, contentKey, lang)
    if (existing && (existing.state === 'done' || existing.state === 'partial')) {
      return answer('ready', existing)
    }
    if (existing && (existing.state === 'requested' || existing.state === 'running')) {
      return answer('in_progress', existing)
    }
    const now = deps.clock.now()
    if (!(await consumeLimit(db, 'translate', member.id, now)).allowed) {
      return answer('rate_limited', existing, 429)
    }

    // A conversion between the Chinese scripts costs nothing: no reservation, and a day's
    // allowance already spent does not refuse it (the rate limit above still counts it).
    const reserve = isScriptConversion(article.source_lang, lang)
      ? 0
      : reservationFor(article.body_chars ?? 0, article.source_lang)
    const day = utcDay(now)
    const requestId = crypto.randomUUID()
    const spent = sql`(select coalesce(sum(used + reserved), 0) from usage_daily
      where subject = ${member.id} and day = ${day})`
    // The request row and its reservation in one batch, both conditional: the row only while the
    // day's allowance has room (or it costs nothing) and nothing is already running, the
    // reservation only for this row.
    await db.batch([
      bumpSeq(db),
      db.run(sql`
        insert into body_translations (content_key, lang, state, request_id, requested_by,
          reserved_tokens, reserved_day, updated_at, seq)
        select ${contentKey}, ${lang}, 'requested', ${requestId}, ${member.id}, ${reserve}, ${day},
          ${now}, ${currentSeq}
        where ${reserve} = 0 or ${spent} + ${reserve} <= ${USER_DAILY_TRANSLATION_TOKENS}
        on conflict (content_key, lang) do update set
          state = 'requested', request_id = excluded.request_id, requested_by = excluded.requested_by,
          reserved_tokens = excluded.reserved_tokens, reserved_day = excluded.reserved_day,
          used_tokens = 0, chunk_keys = '[]', object_key = null, failed_leaves = '[]',
          updated_at = excluded.updated_at, seq = excluded.seq
        where body_translations.state in ('failed', 'skipped')
      `),
      db.run(sql`
        insert into usage_daily (subject, day, reserved, used)
        select ${member.id}, ${day}, ${reserve}, 0
        where exists (select 1 from body_translations
          where content_key = ${contentKey} and lang = ${lang} and request_id = ${requestId})
        on conflict (subject, day) do update set reserved = reserved + excluded.reserved
      `),
    ] as never)
    const row = await loadBodyTranslation(db, contentKey, lang)
    if (row?.requestId !== requestId) {
      if (row && (row.state === 'requested' || row.state === 'running')) {
        return answer('in_progress', row)
      }
      return answer('budget_exhausted', row)
    }

    // Claim it now and hand it to the translate queue; if another holder has it, the sweep will.
    const key = `${contentKey}:${lang}`
    const owner = `translate.body:api:${requestId.slice(0, 8)}`
    const claimed = await claimDue(db, {
      kind: 'translate.body',
      owner,
      now,
      ttlMs: TRANSLATE_BODY_TTL_MS,
      limit: 1,
      due: sql`select * from (${dueBodies()}) where key = ${key}`,
    })
    if (claimed.length > 0) {
      await deps.jobs.send('translate', { kind: 'translate.body', key, owner })
    }
    return answer('requested', row)
  })

  // Polled while an article is open and its translation streams in: what exists right now.
  routes.get('/:contentKey/:lang', async (c) => {
    const row = await loadBodyTranslation(db, c.req.param('contentKey'), c.req.param('lang'))
    if (!row) return c.json({ error: 'not_found' }, 404, { 'cache-control': 'no-store' })
    return c.json(view(row), 200, { 'cache-control': 'no-store' })
  })

  return routes
}

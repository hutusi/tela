/**
 * A reader asking for an article's body in their language (ADR 0023): an RPC, because the reader
 * needs the answer. The work itself is state: a `requested` row the jobs Worker translates in
 * streamed chunks. This route also claims it and sends it on at once, so the first chunk does not
 * wait for the next minute's sweep.
 *
 * Each member's paid requests are counted per UTC day, and every subject's tokens together are
 * held to the site's day (ADR 0057). Past either, a request is not refused but put off: it is
 * charged to tomorrow and waits until the next UTC midnight, one day deep at most. A member with
 * room today who opens a post that waits takes it over, and it runs now.
 */
import {
  admitBodyTranslation,
  type BodyAllowance,
  bodyAllowance,
  bumpSeq,
  claimDue,
  consumeLimit,
  dueBodies,
  first,
  isWaiting,
  loadBodyTranslation,
  readBodyAllowance,
  type TelaDb,
  TRANSLATE_BODY_TTL_MS,
  takeOverBodyTranslation,
} from '@tela/data'
import { isReadingLanguage, MAX_ARTICLE_TRANSLATION_TOKENS } from '@tela/shared'
import { sql } from 'drizzle-orm'
import { Hono } from 'hono'
import type { ApiEnv } from '../app'
import type { ApiDeps } from '../deps'

export type TranslationRequestStatus =
  | 'requested'
  /** Admitted for tomorrow: the row waits until its `dueAt` (ADR 0057). */
  | 'scheduled'
  | 'in_progress'
  | 'ready'
  | 'invalid'
  | 'unavailable'
  | 'rate_limited'
  | 'budget_exhausted'

/**
 * Why a request found no room today or tomorrow: the member's own count, or the site's tokens. A
 * shell from before ADR 0057 words every refusal as the member's allowance, which is why it bumped
 * `MIN_CLIENT`.
 */
export type ExhaustedReason = 'member' | 'site'

/** The member's count as the answer to a request leaves it; `perDay` null is no limit. */
export type TranslationAllowance = { perDay: number | null; usedToday: number; resetsAt: number }

const CJK_SOURCE = /^(zh|ja|ko)\b/
const CHINESE_SCRIPTS: readonly (string | null)[] = ['zh-Hans', 'zh-Hant']

/**
 * A post in one Chinese script read in the other: tela-jobs converts it with OpenCC and asks no
 * model (`scriptConversion` in @tela/llm, which tela-api does not import: it would bundle OpenCC's
 * dictionaries for one comparison). Nothing is spent, so nothing is reserved or counted.
 */
export function isScriptConversion(sourceLang: string | null, lang: string): boolean {
  return (
    sourceLang !== lang && CHINESE_SCRIPTS.includes(sourceLang) && CHINESE_SCRIPTS.includes(lang)
  )
}

/**
 * Tokens to reserve against the day. The reservation is also the job's ceiling on source tokens,
 * so it leans high: a low guess would cut the translation short, while a high one is given back
 * when the job reconciles what it really spent.
 */
export function reservationFor(bodyChars: number, sourceLang: string | null): number {
  const guess = CJK_SOURCE.test(sourceLang ?? '') ? bodyChars : Math.ceil(bodyChars / 4)
  return Math.min(MAX_ARTICLE_TRANSLATION_TOKENS, Math.ceil(guess * 1.5) + 500)
}

/**
 * Which limit a request found no room under. It was refused only once tomorrow had no room
 * either: the member's own count when that is what tomorrow is short of, else the site's tokens.
 */
export function exhaustedReason(allowance: BodyAllowance): ExhaustedReason {
  return allowance.perDay !== null && allowance.usedTomorrow >= allowance.perDay ? 'member' : 'site'
}

type Row = Awaited<ReturnType<typeof loadBodyTranslation>>

/**
 * What the reader sees of a translation: never who asked or what it cost. The seq lets it tell
 * this answer from a synced row of an earlier attempt, which a pull can bring after it. `dueAt`
 * says a request waits for its day (ADR 0057).
 */
const view = (row: NonNullable<Row>) => ({
  contentKey: row.contentKey,
  lang: row.lang,
  state: row.state,
  chunkKeys: row.chunkKeys,
  objectKey: row.objectKey,
  failedLeaves: row.failedLeaves,
  dueAt: row.dueAt,
  seq: row.seq,
})

/** Claim a request now and hand it to the translate queue; if another holder has it, the sweep will. */
async function sendNow(deps: ApiDeps, contentKey: string, lang: string, requestId: string) {
  const now = deps.clock.now()
  const key = `${contentKey}:${lang}`
  const owner = `translate.body:api:${requestId.slice(0, 8)}`
  const claimed = await claimDue(deps.db, {
    kind: 'translate.body',
    owner,
    now,
    ttlMs: TRANSLATE_BODY_TTL_MS,
    limit: 1,
    due: sql`select * from (${dueBodies(now)}) where key = ${key}`,
  })
  if (claimed.length > 0) {
    await deps.jobs.send('translate', { kind: 'translate.body', key, owner })
  }
}

/** Run an ask's statements with the sequence bumped first, and read the member's day after them. */
async function decide(db: TelaDb, statements: unknown[], userId: string, now: number) {
  const results = (await db.batch([
    bumpSeq(db),
    ...statements,
    readBodyAllowance(db, userId, now),
  ] as never)) as unknown as unknown[]
  return bodyAllowance(results.at(-1), now)
}

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
    const answer = (
      status: TranslationRequestStatus,
      row?: Row,
      extra: {
        allowance?: BodyAllowance
        reason?: ExhaustedReason
      } = {},
      code = 200,
    ) =>
      c.json(
        {
          status,
          translation: row ? view(row) : null,
          ...(extra.reason
            ? { reason: extra.reason, resetsAt: extra.allowance?.resetsAt ?? null }
            : {}),
          ...(extra.allowance
            ? {
                allowance: {
                  perDay: extra.allowance.perDay,
                  usedToday: extra.allowance.usedToday,
                  resetsAt: extra.allowance.resetsAt,
                } satisfies TranslationAllowance,
              }
            : {}),
        },
        code as 200,
      )
    if (!Number.isInteger(articleId) || !isReadingLanguage(lang))
      return answer('invalid', null, {}, 400)

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
    const now = deps.clock.now()
    // A conversion between the Chinese scripts costs nothing: its own, far larger rate limit, no
    // reservation and no count, and neither the member's day nor the site's puts it off.
    const conversion = isScriptConversion(article.source_lang, lang)
    const reserve = conversion ? 0 : reservationFor(article.body_chars ?? 0, article.source_lang)
    const ask = {
      contentKey,
      lang,
      userId: member.id,
      requestId: crypto.randomUUID(),
      reserve,
      now,
    }

    if (existing && existing.requestId !== null && isWaiting(existing, now)) {
      // It waits for tomorrow: a reader with room today takes it over, and it runs now. One who
      // asks too often this hour is only told it waits, as one with no room today is.
      if (!(await consumeLimit(db, conversion ? 'convert' : 'translate', member.id, now)).allowed) {
        return answer('scheduled', existing)
      }
      const allowance = await decide(
        db,
        takeOverBodyTranslation(db, ask, {
          requestId: existing.requestId,
          requestedBy: existing.requestedBy,
          reservedDay: existing.reservedDay,
          reservedTokens: existing.reservedTokens,
        }),
        member.id,
        now,
      )
      const row = await loadBodyTranslation(db, contentKey, lang)
      if (row?.requestId === ask.requestId) {
        await sendNow(deps, contentKey, lang, ask.requestId)
        return answer('requested', row, { allowance })
      }
      if (row && isWaiting(row, now)) return answer('scheduled', row, { allowance })
      if (row && (row.state === 'done' || row.state === 'partial')) return answer('ready', row)
      return answer('in_progress', row, { allowance })
    }
    if (existing && (existing.state === 'requested' || existing.state === 'running')) {
      return answer('in_progress', existing)
    }
    if (!(await consumeLimit(db, conversion ? 'convert' : 'translate', member.id, now)).allowed) {
      return answer('rate_limited', existing, {}, 429)
    }
    // The request row and its reservation in one batch, both conditional: the row only on a day
    // with room (today, else tomorrow) and while nothing is already asked for, the reservation
    // only for this row.
    const allowance = await decide(db, admitBodyTranslation(db, ask), member.id, now)
    const row = await loadBodyTranslation(db, contentKey, lang)
    if (row?.requestId !== ask.requestId) {
      if (row && isWaiting(row, now)) return answer('scheduled', row, { allowance })
      if (row && (row.state === 'requested' || row.state === 'running')) {
        return answer('in_progress', row, { allowance })
      }
      return answer('budget_exhausted', row, { allowance, reason: exhaustedReason(allowance) })
    }
    if (row.dueAt !== null) return answer('scheduled', row, { allowance })
    await sendNow(deps, contentKey, lang, ask.requestId)
    return answer('requested', row, { allowance })
  })

  // Polled while an article is open and its translation streams in: what exists right now.
  routes.get('/:contentKey/:lang', async (c) => {
    const row = await loadBodyTranslation(db, c.req.param('contentKey'), c.req.param('lang'))
    if (!row) return c.json({ error: 'not_found' }, 404, { 'cache-control': 'no-store' })
    return c.json(view(row), 200, { 'cache-control': 'no-store' })
  })

  return routes
}

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
  type BodyAsk,
  bodyAllowance,
  bumpSeq,
  claimDue,
  consumeLimit,
  dueBodies,
  first,
  isWaiting,
  loadBodyTranslation,
  readBodyAllowance,
  roomToday,
  type TelaDb,
  TRANSLATE_BODY_TTL_MS,
  takeOverBodyTranslation,
} from '@tela/data'
import { bodySpendFor, isReadingLanguage, MAX_ARTICLE_TRANSLATION_TOKENS } from '@tela/shared'
import { sql } from 'drizzle-orm'
import { Hono } from 'hono'
import type { ApiEnv } from '../app'
import type { ApiDeps } from '../deps'
import { webActor } from '../web-actor'

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
 * Source tokens a request is reserved for: a guess from the body's length, leaning high, since
 * the job translates no more than the reservation pays for and a low guess would cut the post
 * short. At most the per-post ceiling.
 */
export function sourceGuessFor(bodyChars: number, sourceLang: string | null): number {
  const guess = CJK_SOURCE.test(sourceLang ?? '') ? bodyChars : Math.ceil(bodyChars / 4)
  return Math.min(MAX_ARTICLE_TRANSLATION_TOKENS, Math.ceil(guess * 1.5) + 500)
}

/**
 * Tokens to reserve against the day: the whole spend of those source tokens, input and output
 * (`bodySpendFor`), which is what the settle charges. A high guess is given back when the job
 * reconciles what it really spent.
 */
export function reservationFor(bodyChars: number, sourceLang: string | null): number {
  return bodySpendFor(sourceGuessFor(bodyChars, sourceLang))
}

/**
 * Which limit a request found no room under. It was refused only once tomorrow had no room
 * either: the member's own count when that is what tomorrow is short of, else the site's tokens.
 */
export function exhaustedReason(allowance: BodyAllowance): ExhaustedReason {
  return allowance.perDay !== null && allowance.usedTomorrow >= allowance.perDay ? 'member' : 'site'
}

/** The other Chinese script, for a reader of one of them. */
const otherScript = (lang: string) =>
  lang === 'zh-Hans' ? 'zh-Hant' : lang === 'zh-Hant' ? 'zh-Hans' : null

/**
 * A body read in one Chinese script that is already translated into the other, from a third
 * language. The model wrote Simplified for both (ADR 0038), and every leaf it wrote is in the
 * shared block cache, so tela-jobs makes this one from the cache, converted for a Traditional
 * reader, with no call. Free like a conversion: reserved nothing, the job pays for nothing (a
 * reader's request that reserved nothing never reaches a model), and a leaf the other left
 * untranslated stays the source here too.
 */
async function convertsFromOther(db: TelaDb, contentKey: string, lang: string) {
  const other = otherScript(lang)
  if (other === null) return false
  const row = await loadBodyTranslation(db, contentKey, other)
  return row?.state === 'done' || row?.state === 'partial'
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
async function decide(db: TelaDb, statements: unknown[], ask: BodyAsk) {
  const results = (await db.batch([
    bumpSeq(db),
    ...statements,
    readBodyAllowance(db, ask.userId, ask.now, ask.exempt),
  ] as never)) as unknown as unknown[]
  const now = ask.now
  return bodyAllowance(results.at(-1), now)
}

export function translationRoutes(deps: ApiDeps) {
  const { db } = deps
  const routes = new Hono<ApiEnv>()

  routes.post('/', async (c) => {
    const member = c.get('member')
    const { exempt } = await webActor(c, db)
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
    // reservation and no count, and neither the member's day nor the site's puts it off. So does
    // one script of a post the other is already translated into.
    const conversion =
      isScriptConversion(article.source_lang, lang) ||
      (await convertsFromOther(db, contentKey, lang))
    const reserve = conversion ? 0 : reservationFor(article.body_chars ?? 0, article.source_lang)
    const ask: BodyAsk = {
      contentKey,
      lang,
      userId: member.id,
      exempt,
      requestId: crypto.randomUUID(),
      reserve,
      now,
    }

    if (existing && existing.requestId !== null && isWaiting(existing, now)) {
      // It waits for tomorrow: a reader with room today takes it over, and it runs now. One with no
      // room today is told it waits, and spends none of the hour's asks on a take-over that could
      // not happen; one who asks too often this hour is told it waits too.
      const before = bodyAllowance(await readBodyAllowance(db, member.id, now, exempt), now)
      if (!roomToday(before, reserve)) return answer('scheduled', existing, { allowance: before })
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
        ask,
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
    const allowance = await decide(db, admitBodyTranslation(db, ask), ask)
    const row = await loadBodyTranslation(db, contentKey, lang)
    if (row?.requestId !== ask.requestId) {
      // Another request took the row first, and may have finished since: say what it is now.
      if (row && isWaiting(row, now)) return answer('scheduled', row, { allowance })
      if (row && (row.state === 'requested' || row.state === 'running')) {
        return answer('in_progress', row, { allowance })
      }
      if (row && (row.state === 'done' || row.state === 'partial')) return answer('ready', row)
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

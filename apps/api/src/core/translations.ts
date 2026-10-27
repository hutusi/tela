/**
 * Asking for a post's body in a reading language, and what exists of it now (ADRs 0023, 0057):
 * the rules the web's `/api/v1/translations` and the API's `/v1/translations` share (ADR 0065).
 * Each surface words the answer its own way; nothing here reads a request.
 *
 * The work itself is state: a `requested` row the jobs Worker translates in streamed chunks. A
 * request is also claimed and sent on at once, so the first chunk does not wait for the next
 * minute's sweep. Each member's paid requests are counted per UTC day, and every subject's tokens
 * together are held to the site's day (ADR 0057). Past either, a request is not refused but put
 * off: it is charged to tomorrow and waits until the next UTC midnight, one day deep at most. A
 * member with room today who opens a post that waits takes it over, and it runs now. A writer's
 * "no translation" refuses before anything is counted (`unavailable`), whoever asks.
 */
import {
  type Actor,
  admitBodyTranslation,
  type BodyAllowance,
  type BodyAsk,
  type BodyTranslationRow,
  bodyAllowance,
  bumpSeq,
  claimDue,
  consumeLimit,
  dueBodies,
  first,
  isWaiting,
  loadBodyTranslation,
  loadBodyTranslationShown,
  readBodyAllowance,
  roomToday,
  type TelaDb,
  TRANSLATE_BODY_TTL_MS,
  takeOverBodyTranslation,
} from '@tela/data'
import { bodySpendFor, isReadingLanguage, MAX_ARTICLE_TRANSLATION_TOKENS } from '@tela/shared'
import { sql } from 'drizzle-orm'
import type { ApiDeps } from '../deps'

/**
 * Why a request found no room today or tomorrow: the member's own count, or the site's tokens. A
 * shell from before ADR 0057 words every refusal as the member's allowance, which is why it bumped
 * `MIN_CLIENT`.
 */
export type ExhaustedReason = 'member' | 'site'

/**
 * What asking for a body translation came to. `translation` is the row as it stands after the
 * ask, for the surface to show as it shows rows; `allowance` is the member's day as the ask left
 * it, where the ask read it.
 *
 * - `bad_request`: no article id, or a language that is not a reading language.
 * - `not_found`: no such post.
 * - `unavailable`: its writer turned translation off, or it has no body yet.
 * - `invalid`: it is written in that language.
 * - `ready`, `requested` (sent on now), `scheduled` (waits until `translation.dueAt`, ADR 0057),
 *   `in_progress` (someone's request runs).
 * - `rate_limited`: the member asked too often this hour; `retryAfterSec` says when to try again.
 * - `budget_exhausted`: no room today or tomorrow, for `reason`, until `resetsAt`.
 */
export type BodyTranslationAnswer =
  | { status: 'bad_request' }
  | { status: 'not_found' }
  | { status: 'unavailable' }
  | { status: 'invalid' }
  | { status: 'ready'; translation: BodyTranslationRow }
  | { status: 'requested'; translation: BodyTranslationRow; allowance: BodyAllowance }
  | { status: 'scheduled'; translation: BodyTranslationRow; allowance?: BodyAllowance }
  | { status: 'in_progress'; translation: BodyTranslationRow | null; allowance?: BodyAllowance }
  | { status: 'rate_limited'; translation: BodyTranslationRow | null; retryAfterSec: number }
  | {
      status: 'budget_exhausted'
      translation: BodyTranslationRow | null
      allowance: BodyAllowance
      reason: ExhaustedReason
      resetsAt: number
    }

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
  return bodyAllowance(results.at(-1), ask.now)
}

const finished = (row: BodyTranslationRow) => row.state === 'done' || row.state === 'partial'

/**
 * Ask for the body of `articleId` in `lang`, for `actor`. Counted against the actor's day unless
 * they are exempt (an admin on the web; an app never is, ADR 0064), and against the site's.
 */
export async function requestBodyTranslation(
  deps: ApiDeps,
  actor: Actor,
  input: { articleId: number; lang: string },
): Promise<BodyTranslationAnswer> {
  const { db } = deps
  const { articleId, lang } = input
  if (!Number.isInteger(articleId) || !isReadingLanguage(lang)) return { status: 'bad_request' }

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
  if (!article) return { status: 'not_found' }
  // A blog that opted out is refused before anything is counted or reserved.
  if (article.opt_out || !article.content_key) return { status: 'unavailable' }
  if (article.source_lang === lang) return { status: 'invalid' }
  const contentKey = article.content_key

  const existing = await loadBodyTranslation(db, contentKey, lang)
  if (existing && finished(existing)) return { status: 'ready', translation: existing }
  const now = deps.clock.now()
  // A conversion between the Chinese scripts costs nothing: its own, far larger rate limit, no
  // reservation and no count, and neither the member's day nor the site's puts it off. So does
  // one script of a post the other is already translated into.
  const conversion =
    isScriptConversion(article.source_lang, lang) || (await convertsFromOther(db, contentKey, lang))
  const reserve = conversion ? 0 : reservationFor(article.body_chars ?? 0, article.source_lang)
  const ask: BodyAsk = {
    contentKey,
    lang,
    userId: actor.userId,
    exempt: actor.exempt,
    requestId: crypto.randomUUID(),
    reserve,
    now,
  }
  const spend = () => consumeLimit(db, conversion ? 'convert' : 'translate', actor.userId, now)

  if (existing && existing.requestId !== null && isWaiting(existing, now)) {
    // It waits for tomorrow: a reader with room today takes it over, and it runs now. One with no
    // room today is told it waits, and spends none of the hour's asks on a take-over that could
    // not happen; one who asks too often this hour is told it waits too.
    const before = bodyAllowance(await readBodyAllowance(db, actor.userId, now, actor.exempt), now)
    if (!roomToday(before, reserve)) {
      return { status: 'scheduled', translation: existing, allowance: before }
    }
    if (!(await spend()).allowed) return { status: 'scheduled', translation: existing }
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
      return { status: 'requested', translation: row, allowance }
    }
    if (row && isWaiting(row, now)) return { status: 'scheduled', translation: row, allowance }
    if (row && finished(row)) return { status: 'ready', translation: row }
    return { status: 'in_progress', translation: row, allowance }
  }
  if (existing && (existing.state === 'requested' || existing.state === 'running')) {
    return { status: 'in_progress', translation: existing }
  }
  const limited = await spend()
  if (!limited.allowed) {
    return { status: 'rate_limited', translation: existing, retryAfterSec: limited.retryAfterSec }
  }
  // The request row and its reservation in one batch, both conditional: the row only on a day
  // with room (today, else tomorrow) and while nothing is already asked for, the reservation
  // only for this row.
  const allowance = await decide(db, admitBodyTranslation(db, ask), ask)
  const row = await loadBodyTranslation(db, contentKey, lang)
  if (row?.requestId !== ask.requestId) {
    // Another request took the row first, and may have finished since: say what it is now.
    if (row && isWaiting(row, now)) return { status: 'scheduled', translation: row, allowance }
    if (row && (row.state === 'requested' || row.state === 'running')) {
      return { status: 'in_progress', translation: row, allowance }
    }
    if (row && finished(row)) return { status: 'ready', translation: row }
    return {
      status: 'budget_exhausted',
      translation: row,
      allowance,
      reason: exhaustedReason(allowance),
      resetsAt: allowance.resetsAt,
    }
  }
  if (row.dueAt !== null) return { status: 'scheduled', translation: row, allowance }
  await sendNow(deps, contentKey, lang, ask.requestId)
  return { status: 'requested', translation: row, allowance }
}

/**
 * What exists of a body translation right now, polled while it streams in: the row, or null when
 * nobody has asked for one, and whether its writers turned translation off (`optedOut`, ADR
 * 0065), which a surface that cannot leave hiding it to the device refuses. Keyed by content, so
 * it says nothing of who asked or what it cost.
 */
export function translationStatus(
  deps: Pick<ApiDeps, 'db'>,
  contentKey: string,
  lang: string,
): Promise<{ translation: BodyTranslationRow | null; optedOut: boolean }> {
  return loadBodyTranslationShown(deps.db, contentKey, lang)
}

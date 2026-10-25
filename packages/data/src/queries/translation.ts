/**
 * Translation state (ADR 0006, as amended by ADRs 0023 and 0057): the content-addressed block
 * cache, the call log, the daily usage ledger members and the background budget reserve against,
 * and the two kinds of work the sweeps find: titles whose translation is stale, and bodies a
 * reader asked for, some of them waiting for the next UTC day.
 */
import { READING_LANGUAGES } from '@tela/shared'
import { type SQL, sql } from 'drizzle-orm'
import type { TelaDb } from '../db'
import { currentSeq } from '../seq'
import { settingSql } from './settings'

/** A UTC day as the usage ledger keys it. */
export function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10)
}

/** The background budget's ledger subject; members use their own user id. */
export const BACKGROUND = '*'

const DAY_MS = 86_400_000

/** The next UTC midnight after `now`: when a request that waits becomes due (ADR 0057). */
export function nextUtcMidnight(now: number): number {
  return (Math.floor(now / DAY_MS) + 1) * DAY_MS
}

/** Tokens every subject has used and reserved on a UTC day, written against nothing. */
const siteSpent = (day: SQL | string) =>
  sql`(select coalesce(sum(u.used + u.reserved), 0) from usage_daily u where u.day = ${day})`

/** Cached translations for these block hashes, keyed by hash (one read, any number of hashes). */
export async function cachedTranslations(
  db: TelaDb,
  hashes: string[],
  targetLang: string,
  sourceLang: string | null,
): Promise<Map<string, string>> {
  if (hashes.length === 0) return new Map()
  const rows = await db.all<{ source_hash: string; tagged_text: string }>(sql`
    select source_hash, tagged_text from block_translations
    where target_lang = ${targetLang} and source_lang = ${sourceLang ?? 'und'}
      and source_hash in (select value from json_each(${JSON.stringify(hashes)}))
  `)
  return new Map(rows.map((r) => [r.source_hash, r.tagged_text]))
}

export type CacheRow = { sourceHash: string; taggedText: string }

/** Add translations to the shared cache; the first write for a hash wins (ADR 0005). */
export function storeBlockTranslations(
  db: TelaDb,
  rows: CacheRow[],
  meta: { targetLang: string; sourceLang: string | null; model: string; normVersion: number },
  now: number,
) {
  return db.run(sql`
    insert into block_translations (source_hash, target_lang, source_lang, tagged_text, model,
      norm_version, created_at)
    select j.value->>'sourceHash', ${meta.targetLang}, ${meta.sourceLang ?? 'und'},
      j.value->>'taggedText', ${meta.model}, ${meta.normVersion}, ${now}
    from json_each(${JSON.stringify(rows)}) as j where true
    on conflict (source_hash, target_lang, source_lang) do nothing
  `)
}

export type LlmCall = {
  job: 'translate.title' | 'translate.body'
  contentKey: string | null
  articleId: number | null
  /**
   * The blog's feed the call was for (ADR 0039), which is how the console charges a blog: a title
   * job knows it (its lease is the feed). Null lets the row find it from `contentKey`: a body is
   * keyed by content, which two articles may share, so the first article with it answers.
   */
  feedId: number | null
  targetLang: string
  userId: string | null
  model: string
  inputTokens: number
  outputTokens: number
  latencyMs: number
}

export function recordLlmCall(db: TelaDb, call: LlmCall, now: number) {
  const feedId =
    call.feedId !== null || call.contentKey === null
      ? sql`${call.feedId}`
      : sql`(select feed_id from articles where content_key = ${call.contentKey} order by id limit 1)`
  return db.run(sql`
    insert into llm_calls (job, content_key, article_id, feed_id, target_lang, user_id, model,
      input_tokens, output_tokens, latency_ms, created_at)
    values (${call.job}, ${call.contentKey}, ${call.articleId}, ${feedId}, ${call.targetLang},
      ${call.userId}, ${call.model}, ${call.inputTokens}, ${call.outputTokens}, ${call.latencyMs},
      ${now})
  `)
}

/** Charge tokens spent to a subject's ledger for a day. */
export function chargeUsage(db: TelaDb, subject: string, day: string, tokens: number) {
  return db.run(sql`
    insert into usage_daily (subject, day, reserved, used) values (${subject}, ${day}, 0, ${tokens})
    on conflict (subject, day) do update set used = used + excluded.used
  `)
}

/** Tokens a subject has used and reserved on a day. */
export async function usageOn(db: TelaDb, subject: string, day: string): Promise<number> {
  const rows = await db.all<{ n: number }>(sql`
    select coalesce(used, 0) + coalesce(reserved, 0) as n from usage_daily
    where subject = ${subject} and day = ${day}
  `)
  return rows[0]?.n ?? 0
}

/**
 * An article with a title translation to make: it has a title, its site allows translation, and
 * some launch language it is not written in has no row made from its current title hash. Written
 * against `a` (articles) and `s` (sites).
 */
function titleIsDue(): SQL {
  return sql`a.title_hash is not null and a.title <> '' and s.translation_opt_out = 0
    and exists (
      select 1 from json_each(${JSON.stringify(READING_LANGUAGES)}) as l
      where l.value <> coalesce(a.source_lang, '')
        and not exists (
          select 1 from article_titles t
          where t.article_id = a.id and t.lang = l.value and t.source_hash = a.title_hash
        )
    )`
}

const withSite = sql`articles a join feeds f on f.id = a.feed_id join sites s on s.id = f.site_id`

/**
 * Feeds with titles to translate, for `claimDue`. A job takes a feed's due titles together, so one
 * call per language carries up to `TITLES_PER_JOB` of them and the prompt is paid once, not once
 * an article: production's title calls averaged 393 input tokens for about 90 of title and
 * excerpt. Feeds whose newest due post is newest come first, so a blog's imported archive never
 * holds up everyone's new titles (ADR 0057).
 *
 * Titles are background work, so nothing is due once a day's budget is spent: the background
 * budget (`translation.backgroundDailyTokens`; a stored null falls back to tela-jobs'
 * `LLM_DAILY_BUDGET_TOKENS`, `envBudget`, where 0 means no limit), and the site's
 * (`translation.siteDailyTokens`), which counts every subject's tokens, members' bodies too. A
 * setting of 0 pauses titles. Both are read as the statement runs, so a change holds at the next
 * tick.
 */
export function dueTitles(now: number, envBudget: number): SQL {
  const day = utcDay(now)
  const fallback = envBudget > 0 ? envBudget : null
  return sql`
    select a.feed_id as key, null as host, -max(a.sort_at) as ord
    from ${withSite}
    where ${titleIsDue()}
      and exists (
        select 1 from (
          select coalesce(${settingSql('translation.backgroundDailyTokens')}, ${fallback}) as cap,
            (select coalesce(sum(used + reserved), 0) from usage_daily
              where subject = ${BACKGROUND} and day = ${day}) as spent,
            ${settingSql('translation.siteDailyTokens')} as site_cap,
            ${siteSpent(day)} as site_spent
        ) as budget
        where (budget.cap is null or budget.spent < budget.cap)
          and (budget.site_cap is null or budget.site_spent < budget.site_cap)
      )
    group by a.feed_id
  `
}

/** Titles and excerpts one title job translates: at most this many articles of one feed. */
export const TITLES_PER_JOB = 20

export type DueTitle = {
  id: number
  title: string
  excerpt: string | null
  source_lang: string | null
  title_hash: string
}

/** Which of a feed's due titles one job takes: the newest posts, so an archive goes last. */
const NEWEST_DUE = sql`order by a.sort_at desc, a.id desc limit ${TITLES_PER_JOB}`

/** The feed's articles whose titles are due, newest first, one job's worth. */
export function dueTitlesOfFeed(db: TelaDb, feedId: number): Promise<DueTitle[]> {
  return db.all<DueTitle>(sql`
    select a.id, a.title, a.excerpt, a.source_lang, a.title_hash
    from ${withSite}
    where a.feed_id = ${feedId} and ${titleIsDue()}
    ${NEWEST_DUE}
  `)
}

/**
 * Record the titles a job kept failing on as failed, so the sweep stops asking until they change:
 * the same posts `dueTitlesOfFeed` gave it.
 * A row that held the previous title's translation loses it: readers would otherwise see the old
 * headline translated under the new one, and a Traditional title converted from it would copy it.
 * The batch these statements join must bump the sync sequence.
 */
export function failDueTitles(db: TelaDb, feedId: number, now: number) {
  return db.run(sql`
    insert into article_titles (article_id, lang, feed_id, status, source_hash, updated_at, seq)
    select d.id, l.value, d.feed_id, 'failed', d.title_hash, ${now}, ${currentSeq}
    from (
      select a.id, a.feed_id, a.source_lang, a.title_hash from ${withSite}
      where a.feed_id = ${feedId} and ${titleIsDue()}
      ${NEWEST_DUE}
    ) as d, json_each(${JSON.stringify(READING_LANGUAGES)}) as l
    where l.value <> coalesce(d.source_lang, '')
      and not exists (
        select 1 from article_titles t
        where t.article_id = d.id and t.lang = l.value and t.source_hash = d.title_hash
      )
    on conflict (article_id, lang) do update set
      feed_id = excluded.feed_id, status = 'failed', title = null, excerpt = null, model = null,
      source_hash = excluded.source_hash, updated_at = excluded.updated_at, seq = excluded.seq
  `)
}

/**
 * A title translation, stored whatever the outcome so the sweep stops asking (echo, failed). Its
 * feed is read from the article as the batch commits, not passed in: a job leased on a feed that
 * has since merged into another would otherwise file the title under the paused alias (ADR 0028).
 */
export function upsertArticleTitle(
  db: TelaDb,
  row: {
    articleId: number
    lang: string
    title: string | null
    excerpt: string | null
    status: 'done' | 'echo' | 'failed'
    sourceHash: string
    model: string | null
  },
  now: number,
) {
  return db.run(sql`
    insert into article_titles (article_id, lang, feed_id, title, excerpt, status, source_hash,
      model, updated_at, seq)
    select a.id, ${row.lang}, a.feed_id, ${row.title}, ${row.excerpt}, ${row.status},
      ${row.sourceHash}, ${row.model}, ${now}, ${currentSeq}
    from articles a where a.id = ${row.articleId}
    on conflict (article_id, lang) do update set
      feed_id = excluded.feed_id, title = excluded.title, excerpt = excluded.excerpt,
      status = excluded.status, source_hash = excluded.source_hash, model = excluded.model,
      updated_at = excluded.updated_at, seq = excluded.seq
  `)
}

/**
 * How long a body translation's claim holds before its first chunk; each chunk's batch extends it.
 * tela-jobs' kind table and tela-api (which claims a reader's request at once) both use it.
 */
export const TRANSLATE_BODY_TTL_MS = 4 * 60_000

/**
 * Body translations to run: requested, or running with no live lease (an execution that
 * stopped at its deadline, or one that died). A request that waits for the next UTC day
 * (`due_at`, ADR 0057) is not due before then. The key is `<contentKey>:<lang>`. No budget is
 * read here: a body is held to the day's limits when it is asked for, and what was admitted
 * finishes.
 */
export const dueBodies = (now: number): SQL =>
  sql`select content_key || ':' || lang as key, null as host, updated_at as ord
      from body_translations where state in ('requested', 'running')
        and (due_at is null or due_at <= ${now})`

export type BodyTranslationRow = {
  contentKey: string
  lang: string
  state: string
  requestId: string | null
  requestedBy: string | null
  reservedTokens: number
  reservedDay: string | null
  /** A request that waits is not due before this instant (ADR 0057); null once due or started. */
  dueAt: number | null
  usedTokens: number
  chunkKeys: string[]
  /** The finished translation object, once done or partial. */
  objectKey: string | null
  failedLeaves: string[]
  /** Stamped by every write, so the higher of two reads of the row is the later. */
  seq: number
}

export async function loadBodyTranslation(
  db: TelaDb,
  contentKey: string,
  lang: string,
): Promise<BodyTranslationRow | null> {
  const rows = await db.all<{
    content_key: string
    lang: string
    state: string
    request_id: string | null
    requested_by: string | null
    reserved_tokens: number
    reserved_day: string | null
    due_at: number | null
    used_tokens: number
    chunk_keys: string
    object_key: string | null
    failed_leaves: string
    seq: number
  }>(sql`select * from body_translations where content_key = ${contentKey} and lang = ${lang}`)
  const r = rows[0]
  if (!r) return null
  return {
    contentKey: r.content_key,
    lang: r.lang,
    state: r.state,
    requestId: r.request_id,
    requestedBy: r.requested_by,
    reservedTokens: r.reserved_tokens,
    reservedDay: r.reserved_day,
    dueAt: r.due_at === null ? null : Number(r.due_at),
    usedTokens: r.used_tokens,
    chunkKeys: JSON.parse(r.chunk_keys) as string[],
    objectKey: r.object_key,
    failedLeaves: JSON.parse(r.failed_leaves) as string[],
    seq: r.seq,
  }
}

/** Whether a request is waiting for its day (ADR 0057): asked for, and not due yet. */
export const isWaiting = (row: Pick<BodyTranslationRow, 'state' | 'dueAt'>, now: number) =>
  row.state === 'requested' && row.dueAt !== null && row.dueAt > now

/**
 * A member asking for a body translation (ADR 0057). `reserve` is the tokens it reserves, 0 for a
 * conversion between the Chinese scripts, which is free, uncounted and never waits.
 */
export type BodyAsk = {
  contentKey: string
  lang: string
  userId: string
  /** This attempt's id: the statements after the first act only if it is the one written. */
  requestId: string
  reserve: number
  now: number
}

/**
 * The values a request is decided by, bound once each, as a `with` header: `a` for the ask and its
 * two days, `k` for the limits it is held to and whether the member is exempt. Every later term
 * names these columns, so the statement stays at a dozen parameters.
 */
function askHeader(ask: BodyAsk): SQL {
  const tomorrow = nextUtcMidnight(ask.now)
  return sql`with a(me, r, ck, lg, d0, d1, t1, n, s) as (
      select ${ask.userId}, ${ask.requestId}, ${ask.contentKey}, ${ask.lang}, ${utcDay(ask.now)},
        ${utcDay(tomorrow)}, ${tomorrow}, ${ask.reserve}, ${ask.now}
    ),
    k(lim, bud, adm) as (
      select ${settingSql('member.translationsPerDay')}, ${settingSql('translation.siteDailyTokens')},
        exists (select 1 from profiles p, a where p.user_id = a.me and p.is_admin = 1)
    )`
}

/**
 * Whether the asking member has room on `day`, a column of the header (true as SQL): a conversion
 * always has; so has an operator (is_admin), whose translations count toward the site's day but
 * are never put off by it; anyone else needs their count of paid requests under
 * `member.translationsPerDay`, and the site's tokens, this reservation added, within
 * `translation.siteDailyTokens`. A limit of null is none, and 0 leaves no room.
 */
function roomOn(day: SQL): SQL {
  return sql`(a.n = 0 or k.adm or (
    (k.lim is null or coalesce((select u.requests from usage_daily u
      where u.subject = a.me and u.day = ${day}), 0) < k.lim)
    and (k.bud is null or ${siteSpent(day)} + a.n <= k.bud)
  ))`
}

/**
 * The reservation of the request `requestId` names, on the day it chose, counted as one paid
 * request when it reserves anything. It does nothing unless that request is the one the row
 * holds, so it follows the statement that wrote the row, in the same batch.
 */
function reserveFor(db: TelaDb, ask: Pick<BodyAsk, 'contentKey' | 'lang' | 'requestId'>) {
  return db.run(sql`
    insert into usage_daily (subject, day, reserved, used, requests)
    select b.requested_by, b.reserved_day, b.reserved_tokens, 0, b.reserved_tokens > 0
    from body_translations b
    where b.content_key = ${ask.contentKey} and b.lang = ${ask.lang}
      and b.request_id = ${ask.requestId}
    on conflict (subject, day) do update set
      reserved = reserved + excluded.reserved, requests = requests + excluded.requests
  `)
}

/**
 * Admit a request (ADR 0057): today if the member has room today, else tomorrow, waiting until the
 * next UTC midnight (`due_at`), if they have room then, else not at all. The row and its
 * reservation, both conditional; the batch these join starts with `bumpSeq`. A row already asked
 * for, running or finished is left as it is: only a failed or skipped one is asked for again. The
 * caller reads the row to learn which happened: it holds `requestId` only if this one was written.
 */
export function admitBodyTranslation(db: TelaDb, ask: BodyAsk) {
  return [
    db.run(sql`
      ${askHeader(ask)},
      p(day) as (
        select case when ${roomOn(sql`a.d0`)} then a.d0 when ${roomOn(sql`a.d1`)} then a.d1 end
        from a, k
      )
      insert into body_translations (content_key, lang, state, request_id, requested_by,
        reserved_tokens, reserved_day, due_at, updated_at, seq)
      select a.ck, a.lg, 'requested', a.r, a.me, a.n, p.day,
        case when p.day = a.d0 then null else a.t1 end, a.s, ${currentSeq}
      from a, p where p.day is not null
      on conflict (content_key, lang) do update set
        state = 'requested', request_id = excluded.request_id, requested_by = excluded.requested_by,
        reserved_tokens = excluded.reserved_tokens, reserved_day = excluded.reserved_day,
        due_at = excluded.due_at, used_tokens = 0, chunk_keys = '[]', object_key = null,
        failed_leaves = '[]', updated_at = excluded.updated_at, seq = excluded.seq
      where body_translations.state in ('failed', 'skipped')
    `),
    reserveFor(db, ask),
  ]
}

/** The request a take-over replaces, as the caller read it. */
export type WaitingRequest = {
  requestId: string
  requestedBy: string | null
  reservedDay: string | null
  reservedTokens: number
}

/**
 * Take over a request that waits (ADR 0057): a member with room today makes it today's, and
 * theirs. Guarded by the old request id, so of two members racing for it only one moves it. The
 * row moves to the asker, due now, under `ask.requestId`, if it still waits and the asker has room
 * today; the old reservation and its count come off the day they were made on; the asker reserves
 * on today. The last two do nothing unless the first moved the row. `requested_by` never goes
 * null: the settle charges whoever holds the request. The batch these join starts with `bumpSeq`.
 */
export function takeOverBodyTranslation(db: TelaDb, ask: BodyAsk, old: WaitingRequest) {
  const moved = sql`exists (select 1 from body_translations where content_key = ${ask.contentKey}
    and lang = ${ask.lang} and request_id = ${ask.requestId})`
  return [
    db.run(sql`
      ${askHeader(ask)}
      update body_translations set request_id = a.r, requested_by = a.me, reserved_tokens = a.n,
        reserved_day = a.d0, due_at = null, updated_at = a.s, seq = ${currentSeq}
      from a, k
      where body_translations.content_key = a.ck and body_translations.lang = a.lg
        and body_translations.request_id = ${old.requestId}
        and body_translations.state = 'requested' and body_translations.due_at > a.s
        and ${roomOn(sql`a.d0`)}
    `),
    db.run(sql`
      update usage_daily set reserved = max(0, reserved - ${old.reservedTokens}),
        requests = max(0, requests - ${old.reservedTokens > 0 ? 1 : 0})
      where subject = ${old.requestedBy ?? BACKGROUND} and day = ${old.reservedDay} and ${moved}
    `),
    reserveFor(db, ask),
  ]
}

export type BodyAllowance = {
  /** `member.translationsPerDay` as it holds for this member: null for none, or an operator. */
  perDay: number | null
  usedToday: number
  usedTomorrow: number
  /** `translation.siteDailyTokens`, null for none. */
  siteBudget: number | null
  siteToday: number
  siteTomorrow: number
  /** An operator (is_admin): no count, and never put off by the site's day. */
  exempt: boolean
  /** The next UTC midnight: when today's count starts again. */
  resetsAt: number
}

/**
 * Where a member's day and the site's stand, as a statement for the batch that asked, so it reads
 * what that batch wrote. `bodyAllowance` shapes its rows.
 */
export function readBodyAllowance(db: TelaDb, userId: string, now: number) {
  return db.all(sql`
    with a(me, d0, d1) as (select ${userId}, ${utcDay(now)}, ${utcDay(nextUtcMidnight(now))})
    select ${settingSql('member.translationsPerDay')} as lim,
      ${settingSql('translation.siteDailyTokens')} as bud,
      exists (select 1 from profiles p where p.user_id = a.me and p.is_admin = 1) as adm,
      coalesce((select requests from usage_daily where subject = a.me and day = a.d0), 0) as today,
      coalesce((select requests from usage_daily where subject = a.me and day = a.d1), 0)
        as tomorrow,
      ${siteSpent(sql`a.d0`)} as site_today,
      ${siteSpent(sql`a.d1`)} as site_tomorrow
    from a
  `)
}

/** The rows of `readBodyAllowance`, as numbers. */
export function bodyAllowance(rows: unknown, now: number): BodyAllowance {
  const r = (rows as Record<string, unknown>[])[0] ?? {}
  const exempt = r.adm === 1 || r.adm === true
  const number = (v: unknown) => (v === null || v === undefined ? null : Number(v))
  return {
    perDay: exempt ? null : number(r.lim),
    usedToday: Number(r.today ?? 0),
    usedTomorrow: Number(r.tomorrow ?? 0),
    siteBudget: number(r.bud),
    siteToday: Number(r.site_today ?? 0),
    siteTomorrow: Number(r.site_tomorrow ?? 0),
    exempt,
    resetsAt: nextUtcMidnight(now),
  }
}

/**
 * Conclude a body translation's spend on the ledger: give back the reservation made when the
 * reader asked and charge what the translation actually spent, to the member (or `'*'` when no
 * one asked) on the day of the reservation. A member's request that spent nothing at all (every
 * block already cached, or it ended before a call) gives its count back too, never below 0:
 * `member.translationsPerDay` counts what was paid for (ADR 0057). Every ending uses it, success
 * or failure, reported or by exhaustion, placed before the statement that moves the row out of
 * `requested`/`running` in the same batch. The state filter makes it settle a request once: after
 * the flip it matches nothing. The reservation comes off through a subquery rather than a negative
 * `excluded.reserved`, so a ledger row this inserts never holds a negative reservation.
 */
export function settleBodyUsage(db: TelaDb, contentKey: string, lang: string, now: number) {
  const row = sql`from body_translations where content_key = ${contentKey} and lang = ${lang}`
  return db.run(sql`
    insert into usage_daily (subject, day, reserved, used, requests)
    select coalesce(b.requested_by, ${BACKGROUND}), coalesce(b.reserved_day, ${utcDay(now)}), 0,
      b.used_tokens, 0
    from body_translations b
    where b.content_key = ${contentKey} and b.lang = ${lang} and b.state in ('requested', 'running')
    on conflict (subject, day) do update set
      reserved = max(0, usage_daily.reserved - (select reserved_tokens ${row})),
      used = usage_daily.used + excluded.used,
      requests = max(0, usage_daily.requests - (
        select requested_by is not null and reserved_tokens > 0 and used_tokens = 0 ${row}
      ))
  `)
}

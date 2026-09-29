/**
 * Translation state (ADR 0006, as amended by ADR 0023): the content-addressed block cache, the
 * call log, the daily usage ledger members and the background budget reserve against, and the
 * two kinds of work the sweeps find: titles whose translation is stale, and bodies a reader asked
 * for.
 */
import { READING_LANGUAGES } from '@tela/shared'
import { type SQL, sql } from 'drizzle-orm'
import type { TelaDb } from '../db'
import { currentSeq } from '../seq'

/** A UTC day as the usage ledger keys it. */
export function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10)
}

/** The background budget's ledger subject; members use their own user id. */
export const BACKGROUND = '*'

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
  targetLang: string
  userId: string | null
  model: string
  inputTokens: number
  outputTokens: number
  latencyMs: number
}

export function recordLlmCall(db: TelaDb, call: LlmCall, now: number) {
  return db.run(sql`
    insert into llm_calls (job, content_key, article_id, target_lang, user_id, model, input_tokens,
      output_tokens, latency_ms, created_at)
    values (${call.job}, ${call.contentKey}, ${call.articleId}, ${call.targetLang}, ${call.userId},
      ${call.model}, ${call.inputTokens}, ${call.outputTokens}, ${call.latencyMs}, ${now})
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
 * excerpt. Titles are background work, so nothing is due once the day's budget is spent
 * (`budget` 0 means unlimited).
 */
export function dueTitles(now: number, budget: number): SQL {
  const withinBudget =
    budget > 0
      ? sql`and (select coalesce(sum(used + reserved), 0) from usage_daily
                 where subject = ${BACKGROUND} and day = ${utcDay(now)}) < ${budget}`
      : sql``
  return sql`
    select a.feed_id as key, null as host, min(a.id) as ord
    from ${withSite}
    where ${titleIsDue()} ${withinBudget}
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

/** The feed's articles whose titles are due, oldest first, one job's worth. */
export function dueTitlesOfFeed(db: TelaDb, feedId: number): Promise<DueTitle[]> {
  return db.all<DueTitle>(sql`
    select a.id, a.title, a.excerpt, a.source_lang, a.title_hash
    from ${withSite}
    where a.feed_id = ${feedId} and ${titleIsDue()}
    order by a.id limit ${TITLES_PER_JOB}
  `)
}

/**
 * Record the titles a job kept failing on as failed, so the sweep stops asking until they change.
 * The batch these statements join must bump the sync sequence.
 */
export function failDueTitles(db: TelaDb, feedId: number, now: number) {
  return db.run(sql`
    insert into article_titles (article_id, lang, feed_id, status, source_hash, updated_at, seq)
    select d.id, l.value, d.feed_id, 'failed', d.title_hash, ${now}, ${currentSeq}
    from (
      select a.id, a.feed_id, a.source_lang, a.title_hash from ${withSite}
      where a.feed_id = ${feedId} and ${titleIsDue()}
      order by a.id limit ${TITLES_PER_JOB}
    ) as d, json_each(${JSON.stringify(READING_LANGUAGES)}) as l
    where l.value <> coalesce(d.source_lang, '')
      and not exists (
        select 1 from article_titles t
        where t.article_id = d.id and t.lang = l.value and t.source_hash = d.title_hash
      )
    on conflict (article_id, lang) do update set
      feed_id = excluded.feed_id, status = 'failed', source_hash = excluded.source_hash,
      updated_at = excluded.updated_at, seq = excluded.seq
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
 * Body translations to run: requested, or running with no live lease (an execution that
 * stopped at its deadline, or one that died). The key is `<contentKey>:<lang>`.
 */
/**
 * How long a body translation's claim holds before its first chunk; each chunk's batch extends it.
 * tela-jobs' kind table and tela-api (which claims a reader's request at once) both use it.
 */
export const TRANSLATE_BODY_TTL_MS = 4 * 60_000

export const dueBodies = (): SQL =>
  sql`select content_key || ':' || lang as key, null as host, updated_at as ord
      from body_translations where state in ('requested', 'running')`

export type BodyTranslationRow = {
  contentKey: string
  lang: string
  state: string
  requestId: string | null
  requestedBy: string | null
  reservedTokens: number
  reservedDay: string | null
  usedTokens: number
  chunkKeys: string[]
  /** The finished translation object, once done or partial. */
  objectKey: string | null
  failedLeaves: string[]
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
    used_tokens: number
    chunk_keys: string
    object_key: string | null
    failed_leaves: string
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
    usedTokens: r.used_tokens,
    chunkKeys: JSON.parse(r.chunk_keys) as string[],
    objectKey: r.object_key,
    failedLeaves: JSON.parse(r.failed_leaves) as string[],
  }
}

/**
 * Conclude a body translation's spend on the ledger: give back the reservation made when the
 * reader asked and charge what the translation actually spent, to the member (or `'*'` when no
 * one asked) on the day of the reservation. Every ending uses it, success or failure, reported or
 * by exhaustion, placed before the statement that moves the row out of `requested`/`running` in
 * the same batch. The state filter makes it settle a request once: after the flip it matches
 * nothing. The reservation comes off through a subquery rather than a negative
 * `excluded.reserved`, so a ledger row this inserts never holds a negative reservation.
 */
export function settleBodyUsage(db: TelaDb, contentKey: string, lang: string, now: number) {
  return db.run(sql`
    insert into usage_daily (subject, day, reserved, used)
    select coalesce(b.requested_by, ${BACKGROUND}), coalesce(b.reserved_day, ${utcDay(now)}), 0,
      b.used_tokens
    from body_translations b
    where b.content_key = ${contentKey} and b.lang = ${lang} and b.state in ('requested', 'running')
    on conflict (subject, day) do update set
      reserved = max(0, usage_daily.reserved - (
        select reserved_tokens from body_translations
        where content_key = ${contentKey} and lang = ${lang}
      )),
      used = usage_daily.used + excluded.used
  `)
}

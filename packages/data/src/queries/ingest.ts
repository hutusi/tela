/**
 * What the ingest pipeline reads before a fetch and the statements it commits after one. Bulk
 * rows travel as one JSON parameter through json_each (ADR 0021), so a 200-item first fetch is
 * one read and one fenced batch, not hundreds of statements.
 */
import { NORM_VERSION } from '@tela/shared'
import { and, eq, isNull, type SQL, sql } from 'drizzle-orm'
import type { SQLiteUpdateSetSource } from 'drizzle-orm/sqlite-core'
import type { TelaDb } from '../db'
import { first } from '../first'
import { feeds, sites, subscriptions, websubSubscriptions } from '../schema'
import type { ExtractState } from '../schema/values'
import { currentSeq } from '../seq'
import type { VersionSummary } from '../versions'

type FeedRow = typeof feeds.$inferSelect

export type FeedForFetch = FeedRow & {
  site: { id: number; homeUrl: string; claimedBy: string | null; declaredFeedUrls: string[] }
}

export async function loadFeedForFetch(db: TelaDb, feedId: number): Promise<FeedForFetch | null> {
  const rows = await db
    .select({
      feed: feeds,
      site: {
        id: sites.id,
        homeUrl: sites.homeUrl,
        claimedBy: sites.claimedBy,
        declaredFeedUrls: sites.declaredFeedUrls,
      },
    })
    .from(feeds)
    .innerJoin(sites, eq(sites.id, feeds.siteId))
    .where(eq(feeds.id, feedId))
  const row = rows[0]
  if (!row) return null
  return {
    ...row.feed,
    site: { ...row.site, declaredFeedUrls: JSON.parse(row.site.declaredFeedUrls) as string[] },
  }
}

/** Feeds due for a fetch, for `claimDue`: one per host, oldest due first. */
export const dueFeeds = (now: number): SQL =>
  sql`select id as key, host, next_fetch_at as ord from feeds
      where status = 'active' and (next_fetch_at <= ${now} or refetch_requested_at is not null)`

/** Articles whose page should be extracted, for `claimDue`, politely per article host. */
export const dueExtractions = (): SQL =>
  sql`select a.id as key, a.url_host as host, a.fetched_at as ord from articles a
      join feeds f on f.id = a.feed_id
      where a.extract_state = 'due' and a.url is not null and f.status = 'active'`

/** The feed a permanent redirect lands on, when it exists and this row has no reader. */
export async function aliasTarget(db: TelaDb, feedId: number, destination: string) {
  const other = await db.select({ id: feeds.id }).from(feeds).where(eq(feeds.feedUrl, destination))
  const target = other[0]
  if (!target || target.id === feedId) return { exists: false, alias: null as number | null }
  const reader = await db
    .select({ feedId: subscriptions.feedId })
    .from(subscriptions)
    .where(and(eq(subscriptions.feedId, feedId), isNull(subscriptions.deletedAt)))
    .limit(1)
  return { exists: true, alias: reader.length > 0 ? null : target.id }
}

export async function recentArticleCount(db: TelaDb, feedId: number, since: number) {
  const row = await first<{ n: number }>(
    db,
    sql`select count(*) as n from articles where feed_id = ${feedId} and sort_at > ${since}`,
  )
  return row?.n ?? 0
}

export type ExistingArticle = {
  id: number
  dedupKey: string
  currentVersion: number | null
  contentKey: string | null
  extractState: ExtractState
  titleHash: string | null
  versions: StoredVersion[]
}

/** A version as the pipeline needs it: enough to choose, and what to show once chosen. */
export type StoredVersion = VersionSummary & {
  excerpt: string | null
  wordCount: number
  readingMinutes: number
  lang: string | null
}

/** The articles a fetch's items already have, with their versions, in one read. */
export async function existingArticles(
  db: TelaDb,
  feedId: number,
  dedupKeys: string[],
): Promise<Map<string, ExistingArticle>> {
  if (dedupKeys.length === 0) return new Map()
  const rows = await db.all<{
    id: number
    dedup_key: string
    current_version: number | null
    content_key: string | null
    extract_state: ExtractState
    title_hash: string | null
    versions: string
  }>(sql`
    select a.id, a.dedup_key, a.current_version, a.content_key, a.extract_state, a.title_hash,
      coalesce((
        select json_group_array(json_object(
          'version', v.version, 'provenance', v.provenance,
          'contentKey', v.content_key, 'bodyChars', v.body_chars, 'excerpt', v.excerpt,
          'wordCount', v.word_count, 'readingMinutes', v.reading_minutes, 'lang', v.lang))
        from article_versions v where v.article_id = a.id
      ), '[]') as versions
    from articles a
    where a.feed_id = ${feedId} and a.dedup_key in (select value from json_each(${JSON.stringify(dedupKeys)}))
  `)
  return new Map(
    rows.map((r) => [
      r.dedup_key,
      {
        id: r.id,
        dedupKey: r.dedup_key,
        currentVersion: r.current_version,
        contentKey: r.content_key,
        extractState: r.extract_state,
        titleHash: r.title_hash,
        versions: JSON.parse(r.versions) as StoredVersion[],
      },
    ]),
  )
}

/** A new article, as the fetch computed it. */
export type NewArticle = {
  dedupKey: string
  url: string | null
  urlHost: string | null
  title: string
  author: string | null
  publishedAt: number | null
  sourceLang: string | null
  excerpt: string | null
  contentKey: string
  wordCount: number
  readingMinutes: number
  extractState: ExtractState
  titleHash: string
}

/** Insert new articles (version 1 current); returns their ids. Skips any that exist already. */
export function insertArticles(db: TelaDb, feedId: number, rows: NewArticle[], now: number) {
  return db.all<{ id: number; dedup_key: string }>(sql`
    insert into articles (feed_id, dedup_key, url, url_host, title, author, published_at,
      fetched_at, sort_at, source_lang, excerpt, current_version, content_key, word_count,
      reading_minutes, extract_state, title_hash, seq)
    select ${feedId}, j.value->>'dedupKey', j.value->>'url', j.value->>'urlHost',
      j.value->>'title', j.value->>'author', j.value->>'publishedAt', ${now},
      coalesce(j.value->>'publishedAt', ${now}), j.value->>'sourceLang', j.value->>'excerpt', 1,
      j.value->>'contentKey', j.value->>'wordCount', j.value->>'readingMinutes',
      j.value->>'extractState', j.value->>'titleHash', ${currentSeq}
    from json_each(${JSON.stringify(rows)}) as j where true
    on conflict (feed_id, dedup_key) do nothing
    returning id, dedup_key
  `)
}

/** A new version of an article's body. */
export type NewVersion = {
  dedupKey: string
  version: number
  provenance: 'feed' | 'readability'
  contentKey: string
  rawKey: string | null
  bodyChars: number
  excerpt: string | null
  wordCount: number
  readingMinutes: number
  lang: string | null
  sourceUrl: string | null
}

/** Insert versions, finding each article by its dedup key within the feed. */
export function insertVersions(db: TelaDb, feedId: number, rows: NewVersion[], now: number) {
  return db.run(sql`
    insert into article_versions (article_id, version, provenance, content_key, raw_key,
      norm_version, body_chars, excerpt, word_count, reading_minutes, lang, source_url, created_at)
    select a.id, j.value->>'version', j.value->>'provenance', j.value->>'contentKey',
      j.value->>'rawKey', ${NORM_VERSION}, j.value->>'bodyChars', j.value->>'excerpt',
      j.value->>'wordCount', j.value->>'readingMinutes', j.value->>'lang', j.value->>'sourceUrl', ${now}
    from json_each(${JSON.stringify(rows)}) as j
    join articles a on a.feed_id = ${feedId} and a.dedup_key = j.value->>'dedupKey'
    where true
    on conflict (article_id, version) do nothing
  `)
}

/** What an existing article shows after a fetch changed it (the chosen current version's stats). */
export type ArticleChange = {
  id: number
  url: string | null
  urlHost: string | null
  title: string
  author: string | null
  publishedAt: number | null
  sourceLang: string | null
  excerpt: string | null
  currentVersion: number
  contentKey: string
  wordCount: number
  readingMinutes: number
  extractState: ExtractState
  titleHash: string
}

export function updateArticles(db: TelaDb, rows: ArticleChange[]) {
  return db.run(sql`
    update articles set
      url = j.value->>'url', url_host = j.value->>'urlHost', title = j.value->>'title',
      author = j.value->>'author', published_at = j.value->>'publishedAt',
      sort_at = coalesce(j.value->>'publishedAt', articles.fetched_at),
      source_lang = j.value->>'sourceLang', excerpt = j.value->>'excerpt',
      current_version = j.value->>'currentVersion', content_key = j.value->>'contentKey',
      word_count = j.value->>'wordCount', reading_minutes = j.value->>'readingMinutes',
      extract_state = j.value->>'extractState', title_hash = j.value->>'titleHash',
      seq = ${currentSeq}
    from json_each(${JSON.stringify(rows)}) as j
    where articles.id = j.value->>'id'
  `)
}

/**
 * Fill in what the feed knows and the site lacks. The language is the one the site's articles are
 * written in most (SQLite has no `mode()`), the feed's declared tag only a fallback.
 */
export function fillSiteMetadata(
  db: TelaDb,
  feedId: number,
  meta: { title: string | null; description: string | null; declaredLang: string | null },
  now: number,
) {
  return db.run(sql`
    update sites set
      title = coalesce(title, ${meta.title}),
      description = coalesce(description, ${meta.description}),
      primary_lang = coalesce((
        select a.source_lang from articles a join feeds f on f.id = a.feed_id
        where f.site_id = sites.id and a.source_lang is not null
        group by a.source_lang order by count(*) desc, a.source_lang limit 1
      ), ${meta.declaredLang}, primary_lang),
      updated_at = ${now}, seq = ${currentSeq}
    where id = (select site_id from feeds where id = ${feedId})
  `)
}

/** Write the feed row after a fetch; stamps the sync sequence. */
export function updateFeed(
  db: TelaDb,
  feedId: number,
  set: SQLiteUpdateSetSource<typeof feeds>,
  now: number,
) {
  return db
    .update(feeds)
    .set({ ...set, updatedAt: now, seq: currentSeq })
    .where(eq(feeds.id, feedId))
}

/** Record that a feed advertises a hub, so the WebSub sweep subscribes to it. */
export function noteHub(
  db: TelaDb,
  feed: { id: number; feedUrl: string },
  hubUrl: string,
  secret: string,
  now: number,
) {
  return db
    .insert(websubSubscriptions)
    .values({ feedId: feed.id, hubUrl, topicUrl: feed.feedUrl, secret, updatedAt: now })
    .onConflictDoNothing({ target: websubSubscriptions.feedId })
}

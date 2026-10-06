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
  site: {
    id: number
    homeUrl: string
    claimedBy: string | null
    declaredFeedUrls: string[]
    /** The language most of the blog's posts were detected in (`fillSiteMetadata`). */
    primaryLang: string | null
    /** Other active feeds of the same blog: when there are any, this one may be an alias. */
    otherFeeds: number
  }
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
        primaryLang: sites.primaryLang,
        otherFeeds: sql<number>`(select count(*) from feeds o where o.site_id = ${sites.id}
          and o.id <> ${feeds.id} and o.status = 'active' and o.merged_into is null)`,
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

/** How long a feed fetch's claim holds: a 20 s request plus parsing, with room to spare. */
export const FEED_FETCH_TTL_MS = 3 * 60_000

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

/** A blog's active feeds and every post each holds: what tells two feeds apart (ADR 0028). */
export type SiteFeedPosts = {
  id: number
  host: string
  posts: { id: number; url: string | null; dedupKey: string; sortAt: number }[]
}

export async function siteFeedPosts(db: TelaDb, siteId: number): Promise<SiteFeedPosts[]> {
  const rows = await db.all<{
    feed_id: number
    host: string
    id: number | null
    url: string | null
    dedup_key: string | null
    sort_at: number | null
  }>(sql`
    select f.id as feed_id, f.host, a.id, a.url, a.dedup_key, a.sort_at
    from feeds f left join articles a on a.feed_id = f.id
    where f.site_id = ${siteId} and f.status = 'active' and f.merged_into is null
    order by f.id
  `)
  const byFeed = new Map<number, SiteFeedPosts>()
  for (const r of rows) {
    const feed = byFeed.get(r.feed_id) ?? { id: r.feed_id, host: r.host, posts: [] }
    byFeed.set(r.feed_id, feed)
    if (r.id !== null && r.dedup_key !== null && r.sort_at !== null) {
      feed.posts.push({ id: r.id, url: r.url, dedupKey: r.dedup_key, sortAt: r.sort_at })
    }
  }
  return [...byFeed.values()]
}

/**
 * Merge a feed into the one it turned out to be another address for (ADR 0028), as statements
 * for a fenced batch under the alias's lease. The alias stops being fetched; its readers follow
 * the target, keeping the higher watermark; `move` are its posts the target lacks, which go
 * across, with their titles, translations and read states restamped so the target's readers are
 * sent them; `carry` pairs each duplicate with the target's copy, so what a reader read stays
 * read. The duplicates stay behind on the paused alias, where no list shows them.
 *
 * A read the alias's watermark implied is written down as a read, for the moved posts and the
 * target's copies alike, and for readers who left the alias too: once a post is the target's,
 * no alias watermark covers it, and compaction may have dropped the row that said so. A post the
 * member marked unread is not one the watermark said (ADR 0009): it stays unread, and a
 * duplicate's unread goes to the target's copy like its read.
 */
export function mergeFeed(
  db: TelaDb,
  merge: { alias: number; target: number; move: number[]; carry: [number, number][] },
  now: number,
) {
  const { alias, target } = merge
  const move = JSON.stringify(merge.move)
  const carry = JSON.stringify(merge.carry)
  return [
    db.run(sql`
      update feeds set status = 'paused', merged_into = ${target}, updated_at = ${now},
        seq = ${currentSeq}
      where id = ${alias}
    `),
    db.run(sql`
      insert into subscriptions (user_id, feed_id, watermark_id, created_at, updated_at, seq)
      select user_id, ${target}, watermark_id, ${now}, ${now}, ${currentSeq} from subscriptions
      where feed_id = ${alias} and deleted_at is null
      on conflict (user_id, feed_id) do update set
        deleted_at = null, watermark_id = max(subscriptions.watermark_id, excluded.watermark_id),
        updated_at = excluded.updated_at, seq = excluded.seq
    `),
    db.run(sql`
      update subscriptions set deleted_at = ${now}, updated_at = ${now}, seq = ${currentSeq}
      where feed_id = ${alias} and deleted_at is null
    `),
    db.run(sql`
      update articles set feed_id = ${target}, seq = ${currentSeq}
      where feed_id = ${alias} and id in (select value from json_each(${move}))
    `),
    // What hangs off a moved post goes with it. A pull finds titles by feed and every delta by
    // seq, so a device following the target would get the post and never its title, its body's
    // translations, or what its reader had read there.
    db.run(sql`
      update article_titles set feed_id = ${target}, seq = ${currentSeq}
      where article_id in (select value from json_each(${move}))
    `),
    db.run(sql`
      update body_translations set seq = ${currentSeq}
      where content_key in (
        select content_key from articles where id in (select value from json_each(${move}))
      )
    `),
    // A post marked unread beats the watermark (ADR 0009): it stays unread, wherever it moves.
    db.run(sql`
      insert into user_article_states (user_id, article_id, read_at, seq)
      select s.user_id, p.value, ${now}, ${currentSeq}
      from subscriptions s join json_each(${move}) p on p.value <= s.watermark_id
      where s.feed_id = ${alias}
      on conflict (user_id, article_id) do update set
        read_at = coalesce(user_article_states.read_at, excluded.read_at), seq = excluded.seq
      where user_article_states.read_updated_at is null
    `),
    db.run(sql`
      update user_article_states set seq = ${currentSeq}
      where article_id in (select value from json_each(${move}))
    `),
    // A duplicate's read and unread go to the target's copy, each against a choice the member
    // made there by hand as markRead and markUnread go: the later decides.
    db.run(sql`
      insert into user_article_states (user_id, article_id, read_at, seq)
      select s.user_id, p.value->>1, s.read_at, ${currentSeq}
      from json_each(${carry}) p join user_article_states s on s.article_id = p.value->>0
      where s.read_at is not null
      on conflict (user_id, article_id) do update set
        read_at = excluded.read_at,
        read_updated_at = case when user_article_states.read_updated_at is null then null
          else excluded.read_at end,
        seq = excluded.seq
      where user_article_states.read_at is null
        and (user_article_states.read_updated_at is null
          or excluded.read_at >= user_article_states.read_updated_at)
    `),
    db.run(sql`
      insert into user_article_states (user_id, article_id, read_at, read_updated_at, seq)
      select s.user_id, p.value->>1, null, s.read_updated_at, ${currentSeq}
      from json_each(${carry}) p join user_article_states s on s.article_id = p.value->>0
      where s.read_at is null and s.read_updated_at is not null
      on conflict (user_id, article_id) do update set
        read_at = null, read_updated_at = excluded.read_updated_at, seq = excluded.seq
      where excluded.read_updated_at >= max(coalesce(user_article_states.read_updated_at, 0),
        coalesce(user_article_states.read_at, 0))
    `),
    // What the alias's watermark said, except of a duplicate marked unread, which beat it; and
    // never over a copy the member chose read or unread by hand.
    db.run(sql`
      insert into user_article_states (user_id, article_id, read_at, seq)
      select s.user_id, p.value->>1, ${now}, ${currentSeq}
      from json_each(${carry}) p join subscriptions s on p.value->>0 <= s.watermark_id
      where s.feed_id = ${alias} and not exists (
        select 1 from user_article_states u
        where u.user_id = s.user_id and u.article_id = p.value->>0
          and u.read_at is null and u.read_updated_at is not null
      )
      on conflict (user_id, article_id) do update set read_at = excluded.read_at, seq = excluded.seq
      where user_article_states.read_at is null and user_article_states.read_updated_at is null
    `),
  ] as const
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

/** What extraction needs about one article: where to fetch, and the versions it has. */
export type ArticleForExtraction = {
  id: number
  feedId: number
  url: string | null
  title: string
  author: string | null
  sourceLang: string | null
  extractState: ExtractState
  fetchRegion: 'global' | 'cn'
  contentMode: 'unknown' | 'full' | 'summary'
  versions: StoredVersion[]
}

export async function loadArticleForExtraction(
  db: TelaDb,
  articleId: number,
): Promise<ArticleForExtraction | null> {
  const row = await first<{
    id: number
    feed_id: number
    url: string | null
    title: string
    author: string | null
    source_lang: string | null
    extract_state: ExtractState
    fetch_region: 'global' | 'cn'
    content_mode: 'unknown' | 'full' | 'summary'
    versions: string
  }>(
    db,
    sql`
      select a.id, a.feed_id, a.url, a.title, a.author, a.source_lang, a.extract_state,
        f.fetch_region, f.content_mode,
        coalesce((
          select json_group_array(json_object(
            'version', v.version, 'provenance', v.provenance,
            'contentKey', v.content_key, 'bodyChars', v.body_chars, 'excerpt', v.excerpt,
            'wordCount', v.word_count, 'readingMinutes', v.reading_minutes, 'lang', v.lang))
          from article_versions v where v.article_id = a.id
        ), '[]') as versions
      from articles a join feeds f on f.id = a.feed_id
      where a.id = ${articleId}
    `,
  )
  if (!row) return null
  return {
    id: row.id,
    feedId: row.feed_id,
    url: row.url,
    title: row.title,
    author: row.author,
    sourceLang: row.source_lang,
    extractState: row.extract_state,
    fetchRegion: row.fetch_region,
    contentMode: row.content_mode,
    versions: JSON.parse(row.versions) as StoredVersion[],
  }
}

/** Settle an article's extraction without a new version (not longer, no content, or given up). */
export function settleExtraction(db: TelaDb, articleId: number, state: 'done' | 'failed') {
  return db.run(sql`
    update articles set extract_state = ${state}, seq = ${currentSeq}
    where id = ${articleId} and extract_state = 'due'
  `)
}

/** Add an extracted version and point the article at whatever is current now. */
export function adoptExtractedVersion(
  db: TelaDb,
  article: { id: number; feedId: number },
  version: Omit<NewVersion, 'dedupKey'>,
  current: StoredVersion,
  titleHash: string,
  now: number,
) {
  return [
    db.run(sql`
      insert into article_versions (article_id, version, provenance, content_key, raw_key,
        norm_version, body_chars, excerpt, word_count, reading_minutes, lang, source_url, created_at)
      values (${article.id}, ${version.version}, ${version.provenance}, ${version.contentKey},
        ${version.rawKey}, ${NORM_VERSION}, ${version.bodyChars}, ${version.excerpt},
        ${version.wordCount}, ${version.readingMinutes}, ${version.lang}, ${version.sourceUrl}, ${now})
      on conflict (article_id, version) do nothing
    `),
    db.run(sql`
      update articles set
        current_version = ${current.version}, content_key = ${current.contentKey},
        excerpt = ${current.excerpt}, word_count = ${current.wordCount},
        reading_minutes = ${current.readingMinutes},
        source_lang = coalesce(${current.lang}, source_lang),
        title_hash = ${titleHash}, extract_state = 'done', seq = ${currentSeq}
      where id = ${article.id}
    `),
  ] as const
}

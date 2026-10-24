/**
 * What the ingest pipeline reads before a fetch and the statements it commits after one. Bulk
 * rows travel as one JSON parameter through json_each (ADR 0021), so a 200-item first fetch is
 * one read and one fenced batch, not hundreds of statements.
 */
import { NORM_VERSION, PIPELINE_VERSION } from '@tela/shared'
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
    // A blog in a folder stays in it under its other address (ADR 0048), unless the member has
    // put the target somewhere already.
    db.run(sql`
      insert into feed_folders (user_id, feed_id, folder_id, updated_at, seq)
      select user_id, ${target}, folder_id, updated_at, ${currentSeq} from feed_folders
      where feed_id = ${alias} and folder_id is not null
      on conflict (user_id, feed_id) do update set
        folder_id = excluded.folder_id, updated_at = excluded.updated_at, seq = excluded.seq
      where feed_folders.folder_id is null and excluded.updated_at > feed_folders.updated_at
    `),
    // A blog in a blogroll stays in it under its other address (ADR 0050), with its place and its
    // note: the owner's page would otherwise list a paused feed, and subscribing to all of it
    // would subscribe through the alias. A target already in keeps its own; one taken out comes
    // back with the alias's, its clock only moving forward. The alias's rows are then taken out,
    // so the blog is listed once. Blogrolls deleted are left as they were: nothing reads them.
    db.run(sql`
      insert into blogroll_blogs (blogroll_id, feed_id, user_id, note, note_at, added_at,
        updated_at, seq)
      select bb.blogroll_id, ${target}, bb.user_id, bb.note, bb.note_at, bb.added_at,
        bb.updated_at, ${currentSeq}
      from blogroll_blogs bb join blogrolls r on r.id = bb.blogroll_id
      where bb.feed_id = ${alias} and bb.removed_at is null and r.deleted_at is null
      on conflict (blogroll_id, feed_id) do update set
        note = excluded.note, note_at = excluded.note_at, added_at = excluded.added_at,
        removed_at = null, updated_at = max(blogroll_blogs.updated_at, excluded.updated_at),
        seq = excluded.seq
      where blogroll_blogs.removed_at is not null
    `),
    // One taken out goes along too, still out, where the target has no row: its note outlives the
    // take-out (ADR 0050), so putting the blog back under the address the member now reads
    // brings it back, as putting it back under the alias would have.
    db.run(sql`
      insert into blogroll_blogs (blogroll_id, feed_id, user_id, note, note_at, added_at,
        updated_at, removed_at, seq)
      select bb.blogroll_id, ${target}, bb.user_id, bb.note, bb.note_at, bb.added_at,
        bb.updated_at, bb.removed_at, ${currentSeq}
      from blogroll_blogs bb join blogrolls r on r.id = bb.blogroll_id
      where bb.feed_id = ${alias} and bb.removed_at is not null and r.deleted_at is null
      on conflict (blogroll_id, feed_id) do nothing
    `),
    db.run(sql`
      update blogroll_blogs set removed_at = ${now}, updated_at = max(updated_at, ${now}),
        seq = ${currentSeq}
      where feed_id = ${alias} and removed_at is null
        and blogroll_id in (select id from blogrolls where deleted_at is null)
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
    // made there by hand as markRead and markUnread go: the later decides. A read is carried with
    // its clock, and is as late as the later of its first time and its clock: a duplicate read
    // again moved its clock past its first read (ADR 0009), and carried by its first time alone
    // it would lose to an unread made between the two (Codex review). Over a copy already read,
    // it keeps the copy's first time and moves the clock, as a later read does.
    db.run(sql`
      insert into user_article_states (user_id, article_id, read_at, read_updated_at, seq)
      select s.user_id, p.value->>1, s.read_at, s.read_updated_at, ${currentSeq}
      from json_each(${carry}) p join user_article_states s on s.article_id = p.value->>0
      where s.read_at is not null
      on conflict (user_id, article_id) do update set
        read_at = coalesce(user_article_states.read_at, excluded.read_at),
        read_updated_at = case
          when user_article_states.read_at is null and user_article_states.read_updated_at is null
            and excluded.read_updated_at is null then null
          else max(excluded.read_at, coalesce(excluded.read_updated_at, 0)) end,
        seq = excluded.seq
      where (user_article_states.read_at is null
          and (user_article_states.read_updated_at is null
            or max(excluded.read_at, coalesce(excluded.read_updated_at, 0))
              >= user_article_states.read_updated_at))
        or (user_article_states.read_at is not null
          and max(excluded.read_at, coalesce(excluded.read_updated_at, 0))
            > max(user_article_states.read_at, coalesce(user_article_states.read_updated_at, 0)))
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
      norm_version, pipeline_version, body_chars, excerpt, word_count, reading_minutes, lang,
      source_url, created_at)
    select a.id, j.value->>'version', j.value->>'provenance', j.value->>'contentKey',
      j.value->>'rawKey', ${NORM_VERSION}, ${PIPELINE_VERSION}, j.value->>'bodyChars',
      j.value->>'excerpt', j.value->>'wordCount', j.value->>'readingMinutes', j.value->>'lang',
      j.value->>'sourceUrl', ${now}
    from json_each(${JSON.stringify(rows)}) as j
    join articles a on a.feed_id = ${feedId} and a.dedup_key = j.value->>'dedupKey'
    where true
    on conflict (article_id, version) do nothing
  `)
}

/** What an existing article shows after a fetch changed it (the chosen current version's stats). */
export type ArticleChange = {
  id: number
  /** The current version the change was decided from: a writer since then wins (`pointAt`). */
  expectVersion: number | null
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

/**
 * Two statements, for a guarded move and the item's own details. The body moves only from the
 * version the change was decided from, onto a row that holds the content it brings (`pointAt`).
 * What only the feed knows (title, link, author, date) lands whenever the article ends up on the
 * row the change chose, whoever moved it there: a reprocess can make the same body from the stored
 * HTML first, and a fetch that then dropped its edited title would never apply it, since the next
 * fetch finds that body stored and skips the item (Codex's third review). Nothing else writes those
 * columns, and a feed's fetches run one at a time under its lease.
 */
export function updateArticles(db: TelaDb, rows: ArticleChange[]) {
  const changes = JSON.stringify(rows)
  return [
    db.run(sql`
      update articles set
        source_lang = j.value->>'sourceLang', excerpt = j.value->>'excerpt',
        current_version = j.value->>'currentVersion', content_key = j.value->>'contentKey',
        word_count = j.value->>'wordCount', reading_minutes = j.value->>'readingMinutes',
        extract_state = j.value->>'extractState', seq = ${currentSeq}
      from json_each(${changes}) as j
      where articles.id = j.value->>'id'
        and articles.current_version is j.value->>'expectVersion'
        and exists (select 1 from article_versions v where v.article_id = articles.id
          and v.version = j.value->>'currentVersion' and v.content_key = j.value->>'contentKey')
    `),
    db.run(sql`
      update articles set
        url = j.value->>'url', url_host = j.value->>'urlHost', title = j.value->>'title',
        author = j.value->>'author', published_at = j.value->>'publishedAt',
        sort_at = coalesce(j.value->>'publishedAt', articles.fetched_at),
        title_hash = j.value->>'titleHash', seq = ${currentSeq}
      from json_each(${changes}) as j
      where articles.id = j.value->>'id'
        and articles.current_version = j.value->>'currentVersion'
        and articles.content_key = j.value->>'contentKey'
    `),
  ] as const
}

/**
 * A change that did not land must not be forgotten. The fetch that planned it also saves the
 * feed's validators and body hash, so the next fetch would answer 304, or match the hash, and never
 * look at the item again: the post kept its old title and body for good (Codex's review). So when
 * any planned article is not on the row its change chose, this statement, after the feed's own
 * update in the same batch, forgets them and makes the feed due now: its next fetch reads every
 * item and decides again from what the article holds then. An article another writer put on that
 * very row took the change's details from `updateArticles`, and needs nothing again.
 */
export function replayIfRejected(
  db: TelaDb,
  feedId: number,
  changes: ArticleChange[],
  now: number,
) {
  const planned = changes.map((c) => ({ id: c.id, version: c.currentVersion, key: c.contentKey }))
  return db.run(sql`
    update feeds set etag = null, last_modified = null, last_body_hash = null,
      next_fetch_at = ${now}
    where id = ${feedId} and exists (
      select 1 from json_each(${JSON.stringify(planned)}) as j
      join articles a on a.id = j.value->>'id'
      where a.current_version is not j.value->>'version' or a.content_key is not j.value->>'key'
    )
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
  /** What it shows now: the extraction moves it from here, or loses to a writer since. */
  currentVersion: number | null
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
    current_version: number | null
    versions: string
  }>(
    db,
    sql`
      select a.id, a.feed_id, a.url, a.title, a.author, a.source_lang, a.extract_state,
        a.current_version, f.fetch_region, f.content_mode,
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
    currentVersion: row.current_version,
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

/** One version, made by the pipeline at hand, so stamped with it. */
function insertVersion(
  db: TelaDb,
  articleId: number,
  version: Omit<NewVersion, 'dedupKey'>,
  now: number,
) {
  return db.run(sql`
    insert into article_versions (article_id, version, provenance, content_key, raw_key,
      norm_version, pipeline_version, body_chars, excerpt, word_count, reading_minutes, lang,
      source_url, created_at)
    values (${articleId}, ${version.version}, ${version.provenance}, ${version.contentKey},
      ${version.rawKey}, ${NORM_VERSION}, ${PIPELINE_VERSION}, ${version.bodyChars},
      ${version.excerpt}, ${version.wordCount}, ${version.readingMinutes}, ${version.lang},
      ${version.sourceUrl}, ${now})
    on conflict (article_id, version) do nothing
  `)
}

/**
 * Point an article at its current version: what it shows, and the hash its titles key on. Three
 * writers add versions (a feed's fetch, an extraction, a reprocess), each under its own lease, so
 * two can read the same article and both take the next version number: the second insert is
 * ignored, and an unguarded update then pointed the article at the first writer's row with the
 * second's content key, for good. So an article moves only from the current version it was read
 * at, and only onto a row that holds the content it brings. A writer that lost writes nothing,
 * and finds out from the empty RETURNING; the next sweep or fetch decides again from what is there.
 */
function pointAt(
  db: TelaDb,
  articleId: number,
  from: number | null,
  current: StoredVersion,
  titleHash: string,
  extract?: 'done',
) {
  return db.all<{ id: number }>(sql`
    update articles set
      current_version = ${current.version}, content_key = ${current.contentKey},
      excerpt = ${current.excerpt}, word_count = ${current.wordCount},
      reading_minutes = ${current.readingMinutes},
      source_lang = coalesce(${current.lang}, source_lang),
      title_hash = ${titleHash}, extract_state = coalesce(${extract ?? null}, extract_state),
      seq = ${currentSeq}
    where id = ${articleId} and current_version is ${from}
      and exists (select 1 from article_versions where article_id = ${articleId}
        and version = ${current.version} and content_key = ${current.contentKey})
    returning id
  `)
}

/** Whether the `pointAt` among a committed batch's results moved its article. */
export function pointed(results: unknown[], index: number): boolean {
  const rows = results[index]
  return Array.isArray(rows) && rows.length > 0
}

/** Add an extracted version and point the article at whatever is current now. */
export function adoptExtractedVersion(
  db: TelaDb,
  article: { id: number; feedId: number; currentVersion: number | null },
  version: Omit<NewVersion, 'dedupKey'>,
  current: StoredVersion,
  titleHash: string,
  now: number,
) {
  return [
    insertVersion(db, article.id, version, now),
    pointAt(db, article.id, article.currentVersion, current, titleHash, 'done'),
  ] as const
}

/**
 * Articles whose current version was processed under an older pipeline, for `claimDue`: newest
 * first, since those are the ones being read. No fetch, so no host to be polite to. Read through
 * the version index, so once every version is current it reads nothing.
 */
export const dueReprocessing = (): SQL =>
  sql`select v.article_id as key, null as host, 0 - a.sort_at as ord
      from article_versions v
      join articles a on a.id = v.article_id and a.current_version = v.version
      where v.pipeline_version < ${PIPELINE_VERSION}`

/** What reprocessing needs about one article: its current version, its raw HTML, its versions. */
export type ArticleForReprocess = {
  id: number
  url: string | null
  /** The base an item without a link of its own was first made against (`processItem`). */
  feedUrl: string
  title: string
  sourceLang: string | null
  contentMode: 'unknown' | 'full' | 'summary'
  current: {
    version: number
    provenance: 'feed' | 'readability'
    contentKey: string
    rawKey: string | null
    sourceUrl: string | null
    pipelineVersion: number
  }
  versions: StoredVersion[]
}

export async function loadArticleForReprocess(
  db: TelaDb,
  articleId: number,
): Promise<ArticleForReprocess | null> {
  const row = await first<{
    id: number
    url: string | null
    feed_url: string
    title: string
    source_lang: string | null
    content_mode: 'unknown' | 'full' | 'summary'
    version: number
    provenance: 'feed' | 'readability'
    content_key: string
    raw_key: string | null
    source_url: string | null
    pipeline_version: number
    versions: string
  }>(
    db,
    sql`
      select a.id, a.url, f.feed_url, a.title, a.source_lang, f.content_mode,
        v.version, v.provenance, v.content_key, v.raw_key, v.source_url, v.pipeline_version,
        coalesce((
          select json_group_array(json_object(
            'version', o.version, 'provenance', o.provenance,
            'contentKey', o.content_key, 'bodyChars', o.body_chars, 'excerpt', o.excerpt,
            'wordCount', o.word_count, 'readingMinutes', o.reading_minutes, 'lang', o.lang))
          from article_versions o where o.article_id = a.id
        ), '[]') as versions
      from articles a
      join feeds f on f.id = a.feed_id
      join article_versions v on v.article_id = a.id and v.version = a.current_version
      where a.id = ${articleId}
    `,
  )
  if (!row) return null
  return {
    id: row.id,
    url: row.url,
    feedUrl: row.feed_url,
    title: row.title,
    sourceLang: row.source_lang,
    contentMode: row.content_mode,
    current: {
      version: row.version,
      provenance: row.provenance,
      contentKey: row.content_key,
      rawKey: row.raw_key,
      sourceUrl: row.source_url,
      pipelineVersion: row.pipeline_version,
    },
    versions: JSON.parse(row.versions) as StoredVersion[],
  }
}

/**
 * The current pipeline made this version's body again and it came out the same, or never will
 * (no raw HTML): it is current, and stops being due. The version's content is not touched.
 */
export function stampPipeline(db: TelaDb, articleId: number, version: number) {
  return db.run(sql`
    update article_versions set pipeline_version = ${PIPELINE_VERSION}
    where article_id = ${articleId} and version = ${version}
  `)
}

/**
 * Add a version the current pipeline made from a stored body, and point the article at whatever
 * is current now. Its extraction state is left as it was: nothing was fetched.
 */
export function adoptReprocessedVersion(
  db: TelaDb,
  article: { id: number; currentVersion: number },
  version: Omit<NewVersion, 'dedupKey'>,
  current: StoredVersion,
  titleHash: string,
  now: number,
) {
  return [
    insertVersion(db, article.id, version, now),
    pointAt(db, article.id, article.currentVersion, current, titleHash),
  ] as const
}

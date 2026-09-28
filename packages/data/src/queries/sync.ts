/**
 * The server side of a sync pull (ADR 0025): what a member's device is sent, read in one batch so
 * every row comes from one snapshot of the database, whatever commits meanwhile.
 *
 * What a member holds:
 * - their own rows: profile, prefs, subscriptions, read/like states, recommendations, claims;
 * - the shared rows of the feeds they subscribe to: feeds, sites, articles, titles, and the body
 *   translations of those articles;
 * - articles they liked or recommended, wherever those came from.
 *
 * A snapshot (cursor 0) sends all of it within the horizon. A delta sends rows whose seq is above
 * the cursor, plus a horizon snapshot of any feed subscribed since: its articles were written
 * before the subscription, so their seqs are below the cursor.
 */
import type { SQL } from 'drizzle-orm'
import { sql } from 'drizzle-orm'
import type { TelaDb } from '../db'

/** Raw rows as SQL returns them; the API shapes them into the protocol's row types. */
export type RawRow = Record<string, unknown>

export type PullTables =
  | 'profile'
  | 'prefs'
  | 'subscriptions'
  | 'feeds'
  | 'sites'
  | 'articles'
  | 'titles'
  | 'states'
  | 'recommendations'
  | 'claims'
  | 'translations'

export type PullRead = {
  /** The newest seq in this snapshot of the database. */
  head: number
  rows: Record<PullTables, RawRow[]>
  tombstones: RawRow[]
  /** Set when a table's delta was cut at `limit`: rows at or below this seq are complete. */
  pageEnd: number | null
}

const PROFILE = sql.raw(`p.handle, p.display_name as "displayName", p.bio,
  p.ui_locale as "uiLocale", p.reading_lang as "readingLang",
  p.public_subscriptions as "publicSubscriptions", p.seq`)
const PREF = sql.raw(`key, value_json as "valueJson", updated_at as "updatedAt", seq`)
const SUBSCRIPTION = sql.raw(`feed_id as "feedId", watermark_id as "watermarkId",
  created_at as "createdAt", deleted_at as "deletedAt", seq`)
const FEED = sql.raw(`f.id, f.site_id as "siteId", f.feed_url as "feedUrl", f.title, f.status,
  f.last_fetched_at as "lastFetchedAt", f.last_error as "lastError", f.seq`)
const ARTICLE = sql.raw(`a.id, a.feed_id as "feedId", a.url, a.title, a.author,
  a.published_at as "publishedAt", a.fetched_at as "fetchedAt", a.sort_at as "sortAt",
  a.source_lang as "sourceLang", a.excerpt, a.content_key as "contentKey",
  a.word_count as "wordCount", a.reading_minutes as "readingMinutes",
  a.extract_state as "extractState", a.like_count as "likeCount",
  a.recommend_count as "recommendCount", a.seq`)
const TITLE = sql.raw(`t.article_id as "articleId", t.lang, t.title, t.excerpt, t.status, t.seq`)
const STATE = sql.raw(`article_id as "articleId", read_at as "readAt", liked_at as "likedAt",
  liked_updated_at as "likedUpdatedAt", seq`)
const RECOMMENDATION = sql.raw(`article_id as "articleId", note, created_at as "createdAt",
  deleted_at as "deletedAt", seq`)
const CLAIM = sql.raw(`id, site_id as "siteId", method, token, status, error,
  verified_at as "verifiedAt", seq`)
const TRANSLATION = sql.raw(`b.content_key as "contentKey", b.lang, b.state,
  b.chunk_keys as "chunkKeys", b.object_key as "objectKey", b.failed_leaves as "failedLeaves",
  b.seq`)

function siteColumns(userId: string): SQL {
  return sql`s.id, s.home_url as "homeUrl", s.title, s.description, s.favicon_key as "faviconKey",
    s.primary_lang as "primaryLang", s.listing, (s.claimed_by = ${userId}) as "owned",
    (s.claimed_by is not null) as "claimed", s.reader_count as "readerCount",
    s.translation_opt_out as "translationOptOut", s.seq`
}

/** The subqueries a pull is built from, for one member. */
function scope(userId: string, horizon: number, cursor: number) {
  const activeFeeds = sql`select feed_id from subscriptions where user_id = ${userId} and deleted_at is null`
  /** Feeds subscribed (or resubscribed) since the cursor: their horizon comes whole. */
  const newFeeds = sql`select feed_id from subscriptions
    where user_id = ${userId} and deleted_at is null and seq > ${cursor}`
  /** Articles kept whatever their feed: liked or recommended by the member. */
  const kept = sql`select article_id from user_article_states where user_id = ${userId} and liked_at is not null
    union select article_id from recommendations where user_id = ${userId} and deleted_at is null`
  const horizonOf = (feeds: SQL) =>
    sql`select id from articles where feed_id in (${feeds}) and fetched_at >= ${horizon}`
  return { activeFeeds, newFeeds, kept, horizonOf }
}

/**
 * Read everything a member's device should receive after `cursor` (0 for a snapshot), cutting
 * each delta table at `limit` rows. One batch, one snapshot.
 */
export async function readPull(
  db: TelaDb,
  options: { userId: string; cursor: number; horizon: number; limit: number },
): Promise<PullRead> {
  const { userId, cursor, horizon, limit } = options
  const { activeFeeds, newFeeds, kept, horizonOf } = scope(userId, horizon, cursor)
  const snapshot = cursor === 0
  const over = limit + 1
  const bySeq = sql.raw(`order by seq limit ${over}`)

  // In a snapshot every subscribed feed is new, and so are the feeds of articles kept from
  // elsewhere (a liked post from a feed since unsubscribed still names its blog); in a delta only
  // the feeds subscribed since the cursor.
  const fresh = snapshot
    ? sql`${activeFeeds} union select feed_id from articles where id in (${kept})`
    : newFeeds
  const freshArticles = snapshot
    ? sql`select id from articles where id in (${horizonOf(activeFeeds)}) or id in (${kept})`
    : horizonOf(newFeeds)

  const queries = {
    head: sql`select coalesce((select v from counters where k = 'seq'), 0) as head`,
    profile: sql`select ${PROFILE} from profiles p where p.user_id = ${userId}
      ${snapshot ? sql`` : sql`and p.seq > ${cursor}`}`,
    prefs: sql`select ${PREF} from user_prefs where user_id = ${userId}
      ${snapshot ? sql`` : sql`and seq > ${cursor} ${bySeq}`}`,
    subscriptions: snapshot
      ? sql`select ${SUBSCRIPTION} from subscriptions where user_id = ${userId} and deleted_at is null`
      : sql`select ${SUBSCRIPTION} from subscriptions where user_id = ${userId} and seq > ${cursor} ${bySeq}`,
    states: snapshot
      ? sql`select ${STATE} from user_article_states where user_id = ${userId}
          and article_id in (${freshArticles})`
      : sql`select ${STATE} from user_article_states where user_id = ${userId} and seq > ${cursor} ${bySeq}`,
    recommendations: snapshot
      ? sql`select ${RECOMMENDATION} from recommendations where user_id = ${userId} and deleted_at is null`
      : sql`select ${RECOMMENDATION} from recommendations where user_id = ${userId} and seq > ${cursor} ${bySeq}`,
    claims: sql`select ${CLAIM} from site_claims where user_id = ${userId}
      ${snapshot ? sql`` : sql`and seq > ${cursor} ${bySeq}`}`,

    // Shared rows: the fresh part is unbounded (a horizon is bounded by itself); the changed part
    // is cut at `limit` like every other delta table.
    freshFeeds: sql`select ${FEED} from feeds f where f.id in (${fresh})`,
    feeds: snapshot
      ? sql`select 1 where false`
      : sql`select ${FEED} from feeds f where f.id in (${activeFeeds}) and f.seq > ${cursor}
          order by f.seq limit ${over}`,
    freshArticles: sql`select ${ARTICLE} from articles a where a.id in (${freshArticles})`,
    articles: snapshot
      ? sql`select 1 where false`
      : sql`select ${ARTICLE} from articles a where a.feed_id in (${activeFeeds}) and a.seq > ${cursor}
          order by a.seq limit ${over}`,
    freshTitles: sql`select ${TITLE} from article_titles t where t.article_id in (${freshArticles})`,
    titles: snapshot
      ? sql`select 1 where false`
      : sql`select ${TITLE} from article_titles t where t.feed_id in (${activeFeeds}) and t.seq > ${cursor}
          order by t.seq limit ${over}`,
    freshTranslations: sql`select ${TRANSLATION} from body_translations b
      where b.content_key in (select content_key from articles where id in (${freshArticles}))`,
    translations: snapshot
      ? sql`select 1 where false`
      : sql`select ${TRANSLATION} from body_translations b where b.seq > ${cursor}
          and b.content_key in (select content_key from articles where feed_id in (${activeFeeds}))
          order by b.seq limit ${over}`,
    // A site comes with any feed sent (a feed can move to a site the client has never seen),
    // changed sites of subscribed feeds, and sites the member claimed.
    sites: sql`select ${siteColumns(userId)} from sites s where s.id in (
        select site_id from feeds where id in (${fresh})
        ${snapshot ? sql`` : sql`union select site_id from feeds where id in (${activeFeeds}) and seq > ${cursor}`}
      )
      or (s.id in (select site_id from feeds where id in (${activeFeeds})) ${snapshot ? sql`` : sql`and s.seq > ${cursor}`})
      or (s.claimed_by = ${userId} ${snapshot ? sql`` : sql`and s.seq > ${cursor}`})`,
    tombstones: snapshot
      ? sql`select 1 where false`
      : sql`select entity, key, seq from tombstones where seq > ${cursor}
          and (user_id = ${userId} or feed_id in (${activeFeeds})) order by seq limit ${over}`,
  }
  const names = Object.keys(queries) as (keyof typeof queries)[]
  const results = (await db.batch(
    names.map((n) => db.all(queries[n])) as unknown as Parameters<TelaDb['batch']>[0],
  )) as unknown as RawRow[][]
  const got = Object.fromEntries(names.map((n, i) => [n, results[i] ?? []])) as Record<
    keyof typeof queries,
    RawRow[]
  >
  const head = Number(got.head[0]?.head ?? 0)

  // Where the page ends: before the first seq a cut table could not include. Rows share a seq when
  // one batch wrote them, so a table cut inside a seq group ends the page before that group.
  const cut: (keyof typeof queries)[] = snapshot
    ? []
    : [
        'prefs',
        'subscriptions',
        'states',
        'recommendations',
        'claims',
        'feeds',
        'articles',
        'titles',
        'translations',
        'tombstones',
      ]
  let pageEnd: number | null = null
  for (const name of cut) {
    const rows = got[name]
    if (rows.length <= limit) continue
    const firstLeftOut = Number(rows[limit]?.seq)
    const end = firstLeftOut - 1
    pageEnd = pageEnd === null ? end : Math.min(pageEnd, end)
  }
  if (pageEnd !== null && pageEnd <= cursor) {
    // One batch wrote more rows than a page holds, so no page can end inside it: send everything
    // after the cursor unpaged. No writer does this today (the largest is a feed's 200-item cap);
    // this keeps the pull correct if one ever does.
    return readPull(db, { ...options, limit: Number.MAX_SAFE_INTEGER })
  }
  const within = (rows: RawRow[]) =>
    pageEnd === null ? rows : rows.filter((r) => Number(r.seq) <= (pageEnd as number))

  // A feed's fresh horizon belongs to the page that carries its subscription.
  const subscriptions = within(got.subscriptions)
  const freshFeedIds = snapshot
    ? null
    : new Set(subscriptions.filter((s) => s.deletedAt === null).map((s) => Number(s.feedId)))
  const isFresh = (feedId: unknown) => freshFeedIds === null || freshFeedIds.has(Number(feedId))
  const merge = (fresh: RawRow[], changed: RawRow[], key: (r: RawRow) => string) => {
    const out = new Map<string, RawRow>()
    for (const r of within(changed)) out.set(key(r), r)
    for (const r of fresh) out.set(key(r), r)
    return [...out.values()]
  }
  const freshArticlesKept = got.freshArticles.filter((a) => isFresh(a.feedId))
  const freshArticleIds = new Set(freshArticlesKept.map((a) => Number(a.id)))
  const freshContentKeys = new Set(freshArticlesKept.map((a) => String(a.contentKey)))

  return {
    head,
    pageEnd,
    tombstones: within(got.tombstones),
    rows: {
      profile: got.profile,
      prefs: within(got.prefs),
      subscriptions,
      states: within(got.states),
      recommendations: within(got.recommendations),
      claims: within(got.claims),
      feeds: merge(
        got.freshFeeds.filter((f) => isFresh(f.id)),
        got.feeds,
        (r) => String(r.id),
      ),
      articles: merge(freshArticlesKept, got.articles, (r) => String(r.id)),
      titles: merge(
        got.freshTitles.filter((t) => freshArticleIds.has(Number(t.articleId))),
        got.titles,
        (r) => `${r.articleId}:${r.lang}`,
      ),
      translations: merge(
        got.freshTranslations.filter((t) => freshContentKeys.has(String(t.contentKey))),
        got.translations,
        (r) => `${r.contentKey}:${r.lang}`,
      ),
      sites: got.sites,
    },
  }
}

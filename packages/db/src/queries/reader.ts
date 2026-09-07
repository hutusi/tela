import { UNREAD_HORIZON_DAYS } from '@tela/shared'
import { and, desc, eq, gt, isNotNull, isNull, lt, or, sql } from 'drizzle-orm'
import type { Db, DbExecutor } from '../client'
import {
  articleContents,
  articles,
  articleTranslations,
  feeds,
  recommendations,
  sites,
  subscriptions,
  userArticleStates,
} from '../schema'

const HORIZON = sql`now() - make_interval(days => ${UNREAD_HORIZON_DAYS})`

export type ArticleFilter = 'all' | 'today' | 'liked'

export type SubscriptionRow = {
  feedId: number
  siteId: number
  title: string
  homeUrl: string
  faviconKey: string | null
  primaryLang: string | null
  unread: number
  /** Null until the worker has fetched the feed once. */
  lastFetchedAt: Date | null
}

/** Subscriptions with a bounded unread count each, ordered by title. */
export async function listSubscriptions(db: Db, userId: string): Promise<SubscriptionRow[]> {
  const rows = await db.execute<{
    feed_id: number
    site_id: number
    title: string | null
    site_title: string | null
    home_url: string
    favicon_key: string | null
    primary_lang: string | null
    unread: number
    last_fetched_at: Date | null
  }>(sql`
    select s.feed_id, f.site_id, f.title, st.title as site_title, st.home_url, st.favicon_key,
           st.primary_lang, f.last_fetched_at,
           count(a.id) filter (where uas.read_at is null)::int as unread
    from subscriptions s
    join feeds f on f.id = s.feed_id
    join sites st on st.id = f.site_id
    left join articles a
      on a.feed_id = s.feed_id and a.id > s.watermark_id and a.fetched_at > ${HORIZON}
    left join user_article_states uas
      on uas.user_id = s.user_id and uas.article_id = a.id
    where s.user_id = ${userId}
    group by s.feed_id, f.site_id, f.title, st.title, st.home_url, st.favicon_key, st.primary_lang,
             f.last_fetched_at
    order by lower(coalesce(f.title, st.title, st.home_url))
  `)
  // Raw queries return bigint columns as strings; the schema types them as numbers.
  return rows.map((r) => ({
    feedId: Number(r.feed_id),
    siteId: Number(r.site_id),
    title: r.title ?? r.site_title ?? r.home_url,
    homeUrl: r.home_url,
    faviconKey: r.favicon_key,
    primaryLang: r.primary_lang,
    unread: r.unread,
    lastFetchedAt: r.last_fetched_at ? new Date(r.last_fetched_at) : null,
  }))
}

export type UnreadTotals = { all: number; today: number; liked: number }

/** Counts for the sidebar's smart filters. */
export async function countTotals(db: Db, userId: string): Promise<UnreadTotals> {
  const [row] = await db.execute<{ all: number; today: number; liked: number }>(sql`
    select
      coalesce((
        select count(*) from subscriptions s
        join articles a on a.feed_id = s.feed_id and a.id > s.watermark_id and a.fetched_at > ${HORIZON}
        left join user_article_states uas on uas.user_id = s.user_id and uas.article_id = a.id
        where s.user_id = ${userId} and uas.read_at is null
      ), 0)::int as all,
      coalesce((
        select count(*) from subscriptions s
        join articles a on a.feed_id = s.feed_id and a.id > s.watermark_id
          and coalesce(a.published_at, a.fetched_at) > now() - interval '24 hours'
        left join user_article_states uas on uas.user_id = s.user_id and uas.article_id = a.id
        where s.user_id = ${userId} and uas.read_at is null
      ), 0)::int as today,
      coalesce((
        select count(*) from user_article_states where user_id = ${userId} and liked_at is not null
      ), 0)::int as liked
  `)
  return { all: row?.all ?? 0, today: row?.today ?? 0, liked: row?.liked ?? 0 }
}

export type ArticleListItem = {
  id: number
  feedId: number
  siteId: number
  feedTitle: string
  title: string
  excerpt: string | null
  author: string | null
  url: string | null
  publishedAt: Date | null
  fetchedAt: Date
  sourceLang: string | null
  readingMinutes: number | null
  likeCount: number
  recommendCount: number
  isRead: boolean
  isLiked: boolean
  /** Eagerly translated title/excerpt for `translateTo`, when available. */
  translatedTitle: string | null
  translatedExcerpt: string | null
}

export type ListArticlesOptions = {
  filter?: ArticleFilter
  feedId?: number | null
  limit?: number
  /** Reading language: joins article_translations for titles and excerpts. */
  translateTo?: string | null
  /** Keyset cursor: the sort timestamp and id of the last row seen. */
  before?: { at: Date; id: number } | null
}

/** Articles from the user's subscriptions, newest first, with read and liked state. */
export async function listArticles(
  db: Db,
  userId: string,
  options: ListArticlesOptions = {},
): Promise<ArticleListItem[]> {
  const limit = Math.min(options.limit ?? 50, 200)
  const filter = options.filter ?? 'all'
  const sortAt = sql`coalesce(${articles.publishedAt}, ${articles.fetchedAt})`
  const conditions = [eq(subscriptions.userId, userId)]
  if (options.feedId) conditions.push(eq(articles.feedId, options.feedId))
  if (filter === 'today') conditions.push(gt(sortAt, sql`now() - interval '24 hours'`))
  if (filter === 'liked') conditions.push(isNotNull(userArticleStates.likedAt))
  if (options.before) {
    const at = options.before.at.toISOString()
    conditions.push(
      sql`(${sortAt} < ${at}::timestamptz or (${sortAt} = ${at}::timestamptz and ${articles.id} < ${options.before.id}))`,
    )
  }
  const rows = await db
    .select({
      id: articles.id,
      feedId: articles.feedId,
      siteId: feeds.siteId,
      feedTitle: sql<string>`coalesce(${feeds.title}, ${sites.title}, ${sites.homeUrl})`,
      title: articles.title,
      excerpt: articles.excerpt,
      author: articles.author,
      url: articles.url,
      publishedAt: articles.publishedAt,
      fetchedAt: articles.fetchedAt,
      sourceLang: articles.sourceLang,
      readingMinutes: articles.readingMinutes,
      likeCount: articles.likeCount,
      recommendCount: articles.recommendCount,
      readAt: userArticleStates.readAt,
      likedAt: userArticleStates.likedAt,
      watermarkId: subscriptions.watermarkId,
      translatedTitle: articleTranslations.title,
      translatedExcerpt: articleTranslations.excerpt,
    })
    .from(articles)
    .leftJoin(
      articleTranslations,
      and(
        eq(articleTranslations.articleId, articles.id),
        eq(articleTranslations.targetLang, options.translateTo ?? ''),
      ),
    )
    .innerJoin(subscriptions, eq(subscriptions.feedId, articles.feedId))
    .innerJoin(feeds, eq(feeds.id, articles.feedId))
    .innerJoin(sites, eq(sites.id, feeds.siteId))
    .leftJoin(
      userArticleStates,
      and(eq(userArticleStates.articleId, articles.id), eq(userArticleStates.userId, userId)),
    )
    .where(and(...conditions))
    .orderBy(desc(sortAt), desc(articles.id))
    .limit(limit)
  const horizon = Date.now() - UNREAD_HORIZON_DAYS * 24 * 3600 * 1000
  return rows.map(({ readAt, likedAt, watermarkId, ...r }) => ({
    ...r,
    isRead: readAt !== null || r.id <= watermarkId || r.fetchedAt.getTime() <= horizon,
    isLiked: likedAt !== null,
  }))
}

/** The body translation for the asked-for reading language, as the reader needs it. */
export type ArticleTranslationDetail = {
  status: (typeof articleTranslations.$inferSelect)['status']
  contentHash: string | null
  title: string | null
  html: string | null
  failedBlocks: number
}

export type ArticleDetail = ArticleListItem & {
  html: string
  /**
   * Plain-text length of the body, skipped blocks excluded — summed in SQL rather than by
   * shipping the whole `blocks` array to decide one boolean (`wantsExtraction`).
   */
  bodyChars: number
  contentVersion: number
  contentHash: string | null
  /** The feed's learned content mode; `summary` feeds get lazy full-text extraction. */
  contentMode: (typeof feeds.$inferSelect)['contentMode']
  extractedFrom: (typeof articleContents.$inferSelect)['extractedFrom']
  /** Null until extraction has been attempted once (see article.extract). */
  extractCheckedAt: Date | null
  /** When the reader last queued extraction; one request per cooldown window. */
  extractRequestedAt: Date | null
  site: {
    id: number
    title: string | null
    homeUrl: string
    description: string | null
    readerCount: number
    claimedBy: string | null
  }
  isSubscribed: boolean
  /** Present only when `translateTo` was asked for and a row exists. */
  translation: ArticleTranslationDetail | null
  /** The reader's own recommendation of this article, if any. */
  recommendation: { note: string | null } | null
}

/** A uuid that matches no user, so anonymous lookups join nothing. */
const NO_USER = '00000000-0000-0000-0000-000000000000'

export type GetArticleOptions = {
  /** Reading language: joins the body translation and the eager title/excerpt for it. */
  translateTo?: string | null
}

/**
 * One article with everything the reader pane needs, in one round trip: its content, the
 * member's read/liked state, the body translation for the reading language, and the member's own
 * recommendation. Works for unsubscribed articles too.
 *
 * The joins are here rather than in separate helpers because the worker runs beside the database
 * and the web app does not: from a Cloudflare edge the database is a continent away, so three
 * sequential lookups cost three inter-continental round trips to build one pane.
 */
export async function getArticle(
  db: Db,
  userId: string | null,
  articleId: number,
  options: GetArticleOptions = {},
): Promise<ArticleDetail | null> {
  const uid = userId ?? NO_USER
  const targetLang = options.translateTo ?? ''
  // Skipped blocks do not count toward the body length; summing here beats shipping the whole
  // `blocks` array across the wire to decide one boolean (see `wantsExtraction`).
  const bodyChars = sql<number>`coalesce((
    select sum((b->>'chars')::int)
      from jsonb_array_elements(coalesce(${articleContents.blocks}, '[]'::jsonb)) b
     where coalesce((b->>'skip')::boolean, false) is false
  ), 0)::int`
  const [row] = await db
    .select({
      id: articles.id,
      feedId: articles.feedId,
      title: articles.title,
      excerpt: articles.excerpt,
      author: articles.author,
      url: articles.url,
      publishedAt: articles.publishedAt,
      fetchedAt: articles.fetchedAt,
      sourceLang: articles.sourceLang,
      readingMinutes: articles.readingMinutes,
      likeCount: articles.likeCount,
      recommendCount: articles.recommendCount,
      contentVersion: articles.contentVersion,
      contentHash: articles.contentHash,
      extractCheckedAt: articles.extractCheckedAt,
      extractRequestedAt: articles.extractRequestedAt,
      html: articleContents.html,
      extractedFrom: articleContents.extractedFrom,
      bodyChars,
      siteId: feeds.siteId,
      feedTitle: feeds.title,
      contentMode: feeds.contentMode,
      siteTitle: sites.title,
      siteHomeUrl: sites.homeUrl,
      siteDescription: sites.description,
      siteReaderCount: sites.readerCount,
      siteClaimedBy: sites.claimedBy,
      readAt: userArticleStates.readAt,
      likedAt: userArticleStates.likedAt,
      watermarkId: subscriptions.watermarkId,
      translationStatus: articleTranslations.status,
      translationHash: articleTranslations.contentHash,
      translationTitle: articleTranslations.title,
      translationExcerpt: articleTranslations.excerpt,
      translationHtml: articleTranslations.html,
      translationFailedBlockIds: articleTranslations.failedBlockIds,
      // The id, not the note: a recommendation may carry no note, and a left join reports both
      // "no row" and "no note" as null.
      recommendationId: recommendations.id,
      recommendationNote: recommendations.note,
    })
    .from(articles)
    .innerJoin(feeds, eq(feeds.id, articles.feedId))
    .innerJoin(sites, eq(sites.id, feeds.siteId))
    .leftJoin(articleContents, eq(articleContents.articleId, articles.id))
    .leftJoin(
      articleTranslations,
      and(
        eq(articleTranslations.articleId, articles.id),
        eq(articleTranslations.targetLang, targetLang),
      ),
    )
    .leftJoin(
      userArticleStates,
      and(eq(userArticleStates.articleId, articles.id), eq(userArticleStates.userId, uid)),
    )
    .leftJoin(
      subscriptions,
      and(eq(subscriptions.feedId, articles.feedId), eq(subscriptions.userId, uid)),
    )
    .leftJoin(
      recommendations,
      and(eq(recommendations.articleId, articles.id), eq(recommendations.userId, uid)),
    )
    .where(eq(articles.id, articleId))
  if (!row) return null
  return {
    id: row.id,
    feedId: row.feedId,
    siteId: row.siteId,
    feedTitle: row.feedTitle ?? row.siteTitle ?? row.siteHomeUrl,
    title: row.title,
    excerpt: row.excerpt,
    author: row.author,
    url: row.url,
    publishedAt: row.publishedAt,
    fetchedAt: row.fetchedAt,
    sourceLang: row.sourceLang,
    readingMinutes: row.readingMinutes,
    likeCount: row.likeCount,
    recommendCount: row.recommendCount,
    isRead: row.readAt !== null || (row.watermarkId !== null && row.id <= row.watermarkId),
    isLiked: row.likedAt !== null,
    translatedTitle: row.translationTitle,
    translatedExcerpt: row.translationExcerpt,
    html: row.html ?? '',
    bodyChars: row.bodyChars,
    contentVersion: row.contentVersion,
    contentHash: row.contentHash,
    contentMode: row.contentMode,
    extractedFrom: row.extractedFrom ?? 'feed',
    extractCheckedAt: row.extractCheckedAt,
    extractRequestedAt: row.extractRequestedAt,
    site: {
      id: row.siteId,
      title: row.siteTitle,
      homeUrl: row.siteHomeUrl,
      description: row.siteDescription,
      readerCount: row.siteReaderCount,
      claimedBy: row.siteClaimedBy,
    },
    isSubscribed: row.watermarkId !== null,
    translation:
      row.translationStatus === null
        ? null
        : {
            status: row.translationStatus,
            contentHash: row.translationHash,
            title: row.translationTitle,
            html: row.translationHtml,
            failedBlocks: row.translationFailedBlockIds?.length ?? 0,
          },
    recommendation: row.recommendationId === null ? null : { note: row.recommendationNote },
  }
}

/** Minutes before the reader may queue extraction for the same article again. */
export const EXTRACT_COOLDOWN_MINUTES = 10

/**
 * Claim the right to queue extraction for an article: once per cooldown window, and never once
 * an attempt has concluded (`extract_checked_at`). The caller enqueues only when this returns
 * true, so a tab that re-renders every two seconds still causes one job per window; pg-boss's
 * own retries of that job stay inside it.
 */
export async function markExtractRequested(
  db: Db,
  articleId: number,
  cooldownMinutes = EXTRACT_COOLDOWN_MINUTES,
): Promise<boolean> {
  const rows = await db
    .update(articles)
    .set({ extractRequestedAt: new Date() })
    .where(
      and(
        eq(articles.id, articleId),
        isNull(articles.extractCheckedAt),
        or(
          isNull(articles.extractRequestedAt),
          lt(articles.extractRequestedAt, sql`now() - make_interval(mins => ${cooldownMinutes})`),
        ),
      ),
    )
    .returning({ id: articles.id })
  return rows.length > 0
}

/** Record that the user opened an article. Idempotent. */
export async function markRead(db: Db, userId: string, articleId: number): Promise<void> {
  await db
    .insert(userArticleStates)
    .values({ userId, articleId, readAt: new Date() })
    .onConflictDoUpdate({
      target: [userArticleStates.userId, userArticleStates.articleId],
      set: { readAt: sql`coalesce(${userArticleStates.readAt}, now())` },
    })
}

/**
 * Mark everything read for one feed or all subscriptions by moving the watermark to the
 * newest article, and drop read-only state rows that the watermark now covers.
 */
export async function markAllRead(db: Db, userId: string, feedId?: number | null): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`
      update subscriptions s
      set watermark_id = greatest(s.watermark_id, coalesce((select max(id) from articles a where a.feed_id = s.feed_id), 0))
      where s.user_id = ${userId} ${feedId ? sql`and s.feed_id = ${feedId}` : sql``}
    `)
    await tx.execute(sql`
      delete from user_article_states uas
      using articles a, subscriptions s
      where uas.user_id = ${userId} and a.id = uas.article_id and s.user_id = uas.user_id and s.feed_id = a.feed_id
        and uas.liked_at is null and a.id <= s.watermark_id
        ${feedId ? sql`and s.feed_id = ${feedId}` : sql``}
    `)
  })
}

/**
 * Toggle a like; keeps articles.like_count in step. Returns the new state.
 *
 * One upsert flips `liked_at` and reports the outcome, so two concurrent toggles serialise on
 * the row lock and the counter moves by exactly the transition that happened, instead of both
 * reading the same stale state and double-counting.
 */
export async function toggleLike(
  db: Db,
  userId: string,
  articleId: number,
): Promise<{ liked: boolean; likeCount: number }> {
  return db.transaction(async (tx) => {
    const [state] = await tx
      .insert(userArticleStates)
      .values({ userId, articleId, likedAt: new Date(), readAt: new Date() })
      .onConflictDoUpdate({
        target: [userArticleStates.userId, userArticleStates.articleId],
        set: {
          likedAt: sql`case when ${userArticleStates.likedAt} is null then now() else null end`,
          readAt: sql`coalesce(${userArticleStates.readAt}, now())`,
        },
      })
      .returning({ likedAt: userArticleStates.likedAt })
    const liked = state?.likedAt != null
    const [row] = await tx
      .update(articles)
      .set({ likeCount: sql`greatest(0, ${articles.likeCount} + ${liked ? 1 : -1})` })
      .where(eq(articles.id, articleId))
      .returning({ likeCount: articles.likeCount })
    return { liked, likeCount: row?.likeCount ?? 0 }
  })
}

/**
 * Recount distinct readers across every feed of the given sites. Runs on a transaction handle
 * too, so a feed move can recount the site it left and the one it joined before committing.
 */
export async function recomputeSiteReaderCounts(db: DbExecutor, siteIds: number[]): Promise<void> {
  const ids = [...new Set(siteIds)]
  if (ids.length === 0) return
  await db.execute(sql`
    update sites s set reader_count = (
      select count(distinct sub.user_id) from subscriptions sub
      join feeds f on f.id = sub.feed_id where f.site_id = s.id
    )
    where s.id in (${sql.join(
      ids.map((id) => sql`${id}`),
      sql`, `,
    )})
  `)
}

/** Recount distinct readers across every feed of the site a feed belongs to. */
export async function recomputeReaderCount(db: Db, feedId: number): Promise<void> {
  await db.execute(sql`
    update sites s set reader_count = (
      select count(distinct sub.user_id) from subscriptions sub
      join feeds f on f.id = sub.feed_id where f.site_id = s.id
    )
    where s.id = (select site_id from feeds where id = ${feedId})
  `)
}

/** Subscribe; existing articles count as unread from here on. Idempotent. */
export async function subscribe(
  db: Db,
  userId: string,
  feedId: number,
): Promise<{ created: boolean }> {
  const rows = await db
    .insert(subscriptions)
    .values({ userId, feedId })
    .onConflictDoNothing()
    .returning({ feedId: subscriptions.feedId })
  if (rows.length > 0) await recomputeReaderCount(db, feedId)
  return { created: rows.length > 0 }
}

export async function unsubscribe(db: Db, userId: string, feedId: number): Promise<void> {
  await db
    .delete(subscriptions)
    .where(and(eq(subscriptions.userId, userId), eq(subscriptions.feedId, feedId)))
  await recomputeReaderCount(db, feedId)
}

export type ReadingRevisionInput = {
  /** The article body the tab is showing; changes when extraction replaces it. */
  contentHash: string | null
  /** Non-null once extraction has concluded, whatever the outcome. */
  extractCheckedAt: Date | null
  /** The body translation row for the reading language, or null when there is none yet. */
  translation: { status: string; contentHash: string | null } | null
}

/**
 * An opaque tag for everything an open article can be waiting on: the body it is showing, and
 * the state of its translation. A tab polls for this string and refreshes once, when it changes.
 *
 * The point is what it replaces. Re-rendering the reading page to discover that a translation is
 * still running costs a full database wave for the sidebar, the sixty-article list and the body;
 * comparing two short strings costs one indexed row.
 */
export function readingRevision(input: ReadingRevisionInput): string {
  const t = input.translation
  return [
    input.contentHash ?? '',
    input.extractCheckedAt === null ? '0' : '1',
    t?.status ?? 'none',
    t?.contentHash ?? '',
  ].join('|')
}

/** The revision tag for one article, in one query. Null when the article does not exist. */
export async function getReadingRevision(
  db: Db,
  articleId: number,
  targetLang: string,
): Promise<string | null> {
  const [row] = await db
    .select({
      contentHash: articles.contentHash,
      extractCheckedAt: articles.extractCheckedAt,
      translationStatus: articleTranslations.status,
      translationHash: articleTranslations.contentHash,
    })
    .from(articles)
    .leftJoin(
      articleTranslations,
      and(
        eq(articleTranslations.articleId, articles.id),
        eq(articleTranslations.targetLang, targetLang),
      ),
    )
    .where(eq(articles.id, articleId))
  if (!row) return null
  return readingRevision({
    contentHash: row.contentHash,
    extractCheckedAt: row.extractCheckedAt,
    translation:
      row.translationStatus === null
        ? null
        : { status: row.translationStatus, contentHash: row.translationHash },
  })
}

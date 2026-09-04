import {
  dedupKey,
  FeedParseError,
  normalizeLangTag,
  type ParsedFeed,
  type ParsedItem,
  parseFeedText,
  processArticleHtml,
  sha256Hex,
} from '@tela/content'
import { articleContents, articles, type Db, feeds, sites, type Tx } from '@tela/db'
import { and, eq, sql } from 'drizzle-orm'
import { type ContentSample, learnContentMode } from './content-mode'
import { type HttpClient, HttpError } from './http'
import { type RegionPolicy, timeoutsWarrantRelay } from './region'
import {
  backoffSec,
  cacheControlMaxAge,
  DEAD_AFTER_ERRORS,
  nextIntervalSec,
  parseRetryAfter,
  withJitter,
} from './schedule'

export type FetchFeedResult =
  | {
      status: 'fetched'
      newArticles: number
      updatedArticles: number
      items: number
      newArticleIds: number[]
      updatedArticleIds: number[]
    }
  | { status: 'unchanged' }
  | { status: 'error'; error: string; kind: string }
  | { status: 'dead'; error: string }
  | { status: 'skipped'; reason: string }

/** What `onArticleStored` learns about the article whose transaction is about to commit. */
export type StoredArticle = { id: number; sourceLang: string | null; kind: 'inserted' | 'updated' }

export type FetchFeedOptions = {
  now?: () => Date
  random?: () => number
  /** Relay routing policy; absent means a feed never changes region. */
  region?: RegionPolicy
  /**
   * Called inside the transaction that inserts or updates an article, before it commits, with
   * that transaction's handle: work queued through it (title translations) lands together with
   * the article or not at all. A throw rolls that article back and fails the fetch, which
   * pg-boss retries; articles stored before it are kept and count as unchanged then.
   */
  onArticleStored?: (tx: Tx, article: StoredArticle) => Promise<void>
}

type FeedRow = typeof feeds.$inferSelect

function addSeconds(date: Date, sec: number): Date {
  return new Date(date.getTime() + sec * 1000)
}

async function recordError(
  db: Db,
  feed: FeedRow,
  kind: string,
  message: string,
  now: Date,
  opts: { retryAfterSec?: number | null; dead?: boolean },
): Promise<FetchFeedResult> {
  const errorCount = feed.errorCount + 1
  const dead = opts.dead || errorCount >= DEAD_AFTER_ERRORS
  const delay = opts.retryAfterSec ?? backoffSec(feed.fetchIntervalSec, errorCount)
  await db
    .update(feeds)
    .set({
      errorCount,
      timeoutStreak: kind === 'timeout' ? feed.timeoutStreak + 1 : 0,
      lastError: `${kind}: ${message}`.slice(0, 500),
      lastFetchedAt: now,
      nextFetchAt: addSeconds(now, delay),
      status: dead ? 'dead' : feed.status,
    })
    .where(eq(feeds.id, feed.id))
  return dead ? { status: 'dead', error: message } : { status: 'error', error: message, kind }
}

async function itemsLast7d(db: Db, feedId: number, now: Date): Promise<number> {
  const cutoff = addSeconds(now, -7 * 24 * 3600).toISOString()
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(articles)
    .where(
      and(
        eq(articles.feedId, feedId),
        sql`coalesce(${articles.publishedAt}, ${articles.fetchedAt}) > ${cutoff}::timestamptz`,
      ),
    )
  return row?.n ?? 0
}

async function recordSuccess(
  db: Db,
  feed: FeedRow,
  now: Date,
  args: {
    hadNewItems: boolean
    floorSec: number | null
    extra?: Partial<typeof feeds.$inferInsert>
  },
  opts: FetchFeedOptions,
) {
  const count = await itemsLast7d(db, feed.id, now)
  const interval = withJitter(
    nextIntervalSec({
      currentSec: feed.fetchIntervalSec,
      itemsLast7d: count,
      hadNewItems: args.hadNewItems,
      floorSec: args.floorSec,
    }),
    opts.random,
  )
  await db
    .update(feeds)
    .set({
      errorCount: 0,
      timeoutStreak: 0,
      lastError: null,
      lastFetchedAt: now,
      nextFetchAt: addSeconds(now, interval),
      fetchIntervalSec: interval,
      ...args.extra,
    })
    .where(eq(feeds.id, feed.id))
}

function titleFor(item: ParsedItem, excerpt: string): string {
  const t = item.title.replace(/\s+/g, ' ').trim()
  if (t) return t.slice(0, 500)
  if (excerpt) return excerpt.slice(0, 80)
  return 'Untitled'
}

type UpsertOutcome = { kind: 'inserted' | 'updated' | 'unchanged'; id: number | null }

async function upsertArticle(
  db: Db,
  feed: FeedRow,
  parsed: ParsedFeed,
  item: ParsedItem,
  now: Date,
  samples: ContentSample[],
  onStored?: FetchFeedOptions['onArticleStored'],
): Promise<UpsertOutcome> {
  const key = await dedupKey(item)
  const html = item.contentHtml ?? item.summaryHtml ?? ''
  const processed = await processArticleHtml({
    html,
    baseUrl: item.url ?? feed.feedUrl,
    langHint: item.language ?? parsed.language,
    title: item.title,
  })
  samples.push({
    chars: processed.text.length,
    hadFullContent: item.contentHtml !== null,
    tail: processed.text.slice(-40),
  })
  const title = titleFor(item, processed.excerpt)
  const sourceLang = processed.lang === 'und' ? null : processed.lang

  const [existing] = await db
    .select({
      id: articles.id,
      contentHash: articles.contentHash,
      contentVersion: articles.contentVersion,
    })
    .from(articles)
    .where(and(eq(articles.feedId, feed.id), eq(articles.dedupKey, key)))

  if (!existing) {
    let insertedId: number | null = null
    await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(articles)
        .values({
          feedId: feed.id,
          dedupKey: key,
          url: item.url,
          title,
          author: item.author,
          publishedAt: item.publishedAt,
          fetchedAt: now,
          sourceLang,
          excerpt: processed.excerpt || null,
          contentHash: processed.contentHash,
          wordCount: processed.wordCount,
          readingMinutes: processed.readingMinutes,
        })
        .returning({ id: articles.id })
      const id = (row as { id: number }).id
      insertedId = id
      await tx.insert(articleContents).values({
        articleId: id,
        html: processed.html,
        blocks: processed.blocks,
        extractedFrom: 'feed',
      })
      if (onStored) await onStored(tx, { id, sourceLang, kind: 'inserted' })
    })
    return { kind: 'inserted', id: insertedId }
  }

  if (existing.contentHash === processed.contentHash || processed.text.length === 0) {
    return { kind: 'unchanged', id: existing.id }
  }

  await db.transaction(async (tx) => {
    await tx
      .update(articles)
      .set({
        url: item.url,
        title,
        author: item.author,
        publishedAt: item.publishedAt,
        sourceLang,
        excerpt: processed.excerpt || null,
        contentHash: processed.contentHash,
        contentVersion: existing.contentVersion + 1,
        wordCount: processed.wordCount,
        readingMinutes: processed.readingMinutes,
      })
      .where(eq(articles.id, existing.id))
    await tx
      .insert(articleContents)
      .values({
        articleId: existing.id,
        html: processed.html,
        blocks: processed.blocks,
        extractedFrom: 'feed',
      })
      .onConflictDoUpdate({
        target: articleContents.articleId,
        set: {
          html: processed.html,
          blocks: processed.blocks,
          extractedFrom: 'feed',
          updatedAt: now,
        },
      })
    if (onStored) await onStored(tx, { id: existing.id, sourceLang, kind: 'updated' })
  })
  return { kind: 'updated', id: existing.id }
}

/**
 * Fetch one feed: conditional GET, body-hash short-circuit, parse, upsert site and feed
 * metadata, dedup and store articles, learn the content mode, and reschedule.
 */
export async function fetchFeed(
  db: Db,
  http: HttpClient,
  feedId: number,
  opts: FetchFeedOptions = {},
): Promise<FetchFeedResult> {
  const now = opts.now ? opts.now() : new Date()
  const [feed] = await db.select().from(feeds).where(eq(feeds.id, feedId))
  if (!feed) return { status: 'skipped', reason: 'feed not found' }
  if (feed.status !== 'active') return { status: 'skipped', reason: `feed is ${feed.status}` }

  let res: Awaited<ReturnType<HttpClient['get']>>
  try {
    res = await http.get(feed.feedUrl, {
      etag: feed.etag,
      lastModified: feed.lastModified,
      region: feed.fetchRegion,
    })
  } catch (err) {
    if (!(err instanceof HttpError)) throw err
    const policy = opts.region
    if (
      err.kind === 'timeout' &&
      policy &&
      timeoutsWarrantRelay(feed, policy) &&
      (await policy.controlOk())
    ) {
      // The origin keeps timing out while our own connectivity is fine: route it through the
      // relay from now on and retry at the next scheduler tick.
      const streak = feed.timeoutStreak + 1
      await db
        .update(feeds)
        .set({
          fetchRegion: 'cn',
          regionFlippedAt: now,
          timeoutStreak: 0,
          errorCount: feed.errorCount + 1,
          lastError: `timeout: routed through the relay after ${streak} timeouts`,
          lastFetchedAt: now,
          nextFetchAt: now,
        })
        .where(eq(feeds.id, feed.id))
      return { status: 'error', error: 'routed through the relay', kind: 'region_flip' }
    }
    return recordError(db, feed, err.kind, err.message, now, {})
  }

  if (res.status === 304) {
    await recordSuccess(
      db,
      feed,
      now,
      { hadNewItems: false, floorSec: cacheControlMaxAge(res.headers.get('cache-control')) },
      opts,
    )
    return { status: 'unchanged' }
  }
  if (res.status === 429 || res.status === 503) {
    const retryAfterSec = parseRetryAfter(res.headers.get('retry-after'), now)
    return recordError(db, feed, `http_${res.status}`, 'rate limited', now, { retryAfterSec })
  }
  if (res.status === 410) {
    return recordError(db, feed, 'http_410', 'gone', now, { dead: true })
  }
  if (res.status !== 200) {
    return recordError(db, feed, `http_${res.status}`, `unexpected status ${res.status}`, now, {})
  }

  const bodyHash = await sha256Hex(res.body)
  if (bodyHash === feed.lastBodyHash) {
    await recordSuccess(
      db,
      feed,
      now,
      {
        hadNewItems: false,
        floorSec: cacheControlMaxAge(res.headers.get('cache-control')),
        extra: { etag: res.headers.get('etag'), lastModified: res.headers.get('last-modified') },
      },
      opts,
    )
    return { status: 'unchanged' }
  }

  let parsed: ParsedFeed
  try {
    parsed = parseFeedText(res.body, res.finalUrl)
  } catch (err) {
    if (err instanceof FeedParseError) return recordError(db, feed, 'parse', err.message, now, {})
    throw err
  }

  const samples: ContentSample[] = []
  const newArticleIds: number[] = []
  const updatedArticleIds: number[] = []
  for (const item of parsed.items) {
    const outcome = await upsertArticle(db, feed, parsed, item, now, samples, opts.onArticleStored)
    if (outcome.kind === 'inserted' && outcome.id !== null) newArticleIds.push(outcome.id)
    else if (outcome.kind === 'updated' && outcome.id !== null) updatedArticleIds.push(outcome.id)
  }
  const newArticles = newArticleIds.length
  const updatedArticles = updatedArticleIds.length

  // Fill in site metadata the feed knows and the site row lacks. The language comes from what
  // the site's articles are written in; feeds declare "zh", "en-us", or nothing at all, so the
  // declared tag is only a normalized fallback while no article has been detected yet.
  const [dominant] = await db.execute<{ lang: string | null }>(sql`
    select mode() within group (order by a.source_lang) as lang
    from articles a join feeds f on f.id = a.feed_id
    where f.site_id = ${feed.siteId} and a.source_lang is not null
  `)
  const primaryLang = dominant?.lang ?? normalizeLangTag(parsed.language)
  await db
    .update(sites)
    .set({
      title: sql`coalesce(${sites.title}, ${parsed.title})`,
      description: sql`coalesce(${sites.description}, ${parsed.description})`,
      primaryLang: sql`coalesce(${primaryLang}::text, ${sites.primaryLang})`,
    })
    .where(eq(sites.id, feed.siteId))

  const publishedDates = parsed.items.map((i) => i.publishedAt).filter((d): d is Date => d !== null)
  const lastItemAt =
    publishedDates.length > 0
      ? new Date(Math.max(...publishedDates.map((d) => d.getTime())))
      : feed.lastItemAt
  const contentMode = feed.contentMode === 'unknown' ? learnContentMode(samples) : feed.contentMode
  const floors = [
    parsed.ttlMinutes ? parsed.ttlMinutes * 60 : null,
    cacheControlMaxAge(res.headers.get('cache-control')),
  ]
  const floorSec = floors.reduce<number | null>(
    (acc, f) => (f && (!acc || f > acc) ? f : acc),
    null,
  )

  await recordSuccess(
    db,
    feed,
    now,
    {
      hadNewItems: newArticles > 0,
      floorSec,
      extra: {
        etag: res.headers.get('etag'),
        lastModified: res.headers.get('last-modified'),
        lastBodyHash: bodyHash,
        format: parsed.format,
        title: parsed.title ?? feed.title,
        description: parsed.description ?? feed.description,
        hubUrl: parsed.hubUrl,
        contentMode,
        lastItemAt,
        feedUrl: res.permanentRedirectTo ?? feed.feedUrl,
      },
    },
    opts,
  ).catch(async (err: unknown) => {
    // A permanent redirect onto a URL that already exists as another feed: keep ours.
    if (res.permanentRedirectTo && String(err).includes('feeds_feed_url_key')) {
      await recordSuccess(
        db,
        feed,
        now,
        { hadNewItems: newArticles > 0, floorSec, extra: { lastBodyHash: bodyHash } },
        opts,
      )
      return
    }
    throw err
  })

  return {
    status: 'fetched',
    newArticles,
    updatedArticles,
    items: parsed.items.length,
    newArticleIds,
    updatedArticleIds,
  }
}

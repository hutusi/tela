import {
  dedupKey,
  FeedParseError,
  normalizeLangTag,
  normalizeOrigin,
  type ParsedFeed,
  type ParsedItem,
  parseFeedText,
  processArticleHtml,
  sha256Hex,
} from '@tela/content'
import {
  articleContents,
  articles,
  type Db,
  feedIsVouched,
  feeds,
  moveFeedToOriginSite,
  sites,
  subscriptions,
  type Tx,
} from '@tela/db'
import { and, eq, isNull, ne, sql } from 'drizzle-orm'
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
      /** What happened to the site's home URL once the feed declared one. */
      siteHome: HomeUrlOutcome
      /** Items beyond MAX_ITEMS_PER_FETCH, left alone this time. */
      itemsSkipped: number
      /**
       * Set when this feed's permanent redirect lands on a URL another feed already holds. This
       * feed keeps its own URL; the id is the feed it duplicates, so a caller that just created
       * it can undo that rather than keep two rows for one blog.
       */
      duplicateOf?: number
    }
  | { status: 'unchanged' }
  | { status: 'error'; error: string; kind: string }
  | { status: 'dead'; error: string }
  | { status: 'skipped'; reason: string; duplicateOf?: number }

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

/**
 * Ceiling on items one fetch processes. A first fetch of a long archive, or a hostile feed of
 * thousands of tiny items, would otherwise become that many selects and transactions inside a
 * single job. Lists show the newest posts, so those are the ones kept.
 */
export const MAX_ITEMS_PER_FETCH = 200

/** The newest `limit` items: dated ones first, newest first; undated ones keep document order after them. */
export function selectItems(items: ParsedItem[], limit = MAX_ITEMS_PER_FETCH): ParsedItem[] {
  if (items.length <= limit) return items
  const indexed = items.map((item, i) => ({ item, i, at: item.publishedAt?.getTime() }))
  indexed.sort((a, b) => {
    if (a.at !== undefined && b.at !== undefined && a.at !== b.at) return b.at - a.at
    if (a.at !== undefined && b.at === undefined) return -1
    if (a.at === undefined && b.at !== undefined) return 1
    return a.i - b.i
  })
  return indexed.slice(0, limit).map((x) => x.item)
}

export type HomeUrlOutcome = 'kept' | 'renamed' | 'joined' | 'split' | 'blocked' | 'detached'

/**
 * Provenance for claimed sites (see feedIsVouched in @tela/db): a feed's posts belong to the
 * origin that actually served them. A URL on a member's site that redirects elsewhere (an open
 * redirector, a hosted feed the owner never declared) must not put someone else's posts under
 * that member's site, so before anything is stored the feed moves to the served origin's site.
 */
async function enforceProvenance(
  db: Db,
  feed: FeedRow,
  servedOrigin: string | null,
): Promise<{ feed: FeedRow; detached: boolean }> {
  if (servedOrigin && servedOrigin !== feed.servedOrigin) {
    await db.update(feeds).set({ servedOrigin }).where(eq(feeds.id, feed.id))
  }
  const current: FeedRow = { ...feed, servedOrigin: servedOrigin ?? feed.servedOrigin }
  const [site] = await db
    .select({
      homeUrl: sites.homeUrl,
      claimedBy: sites.claimedBy,
      declaredFeedUrls: sites.declaredFeedUrls,
    })
    .from(sites)
    .where(eq(sites.id, feed.siteId))
  if (!site || !servedOrigin || feedIsVouched(current, site))
    return { feed: current, detached: false }
  const siteId = await db.transaction((tx) => moveFeedToOriginSite(tx, current, servedOrigin))
  return { feed: { ...current, siteId }, detached: siteId !== feed.siteId }
}

/**
 * Sites are keyed by origin, and a feed added by URL starts on a placeholder site keyed by the
 * feed's own origin. A feed served from elsewhere (FeedBurner, a CDN, a hosted newsletter)
 * would leave the blog attached to that host, which is where claim verification looks for the
 * proof and what readers see as the site. Once the feed declares its home, move the feed there:
 * rename the placeholder when this is its only feed and the declared origin is free, otherwise
 * give the feed its own site (`split`) or join an existing site nobody has claimed. A claimed
 * placeholder or a claimed target is left alone: a feed must not be able to move a member's
 * site or attach itself to one.
 */
async function adoptDeclaredHome(
  db: Db,
  feed: FeedRow,
  declaredHome: string | null,
): Promise<{ siteId: number; outcome: HomeUrlOutcome }> {
  const declared = declaredHome ? normalizeOrigin(declaredHome) : null
  const [site] = await db
    .select({ id: sites.id, homeUrl: sites.homeUrl, claimedBy: sites.claimedBy })
    .from(sites)
    .where(eq(sites.id, feed.siteId))
  const keyedByFeedHost = site !== undefined && site.homeUrl === normalizeOrigin(feed.feedUrl)
  if (!site || !declared || declared === site.homeUrl || !keyedByFeedHost) {
    return { siteId: feed.siteId, outcome: 'kept' }
  }
  if (site.claimedBy !== null) return { siteId: site.id, outcome: 'blocked' }
  const [target] = await db
    .select({ id: sites.id, claimedBy: sites.claimedBy })
    .from(sites)
    .where(eq(sites.homeUrl, declared))
  if (target?.claimedBy) return { siteId: site.id, outcome: 'blocked' }

  const [siblings] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(feeds)
    .where(and(eq(feeds.siteId, site.id), ne(feeds.id, feed.id)))
  if (!target && (siblings?.n ?? 0) === 0) {
    await db.update(sites).set({ homeUrl: declared }).where(eq(sites.id, site.id))
    return { siteId: site.id, outcome: 'renamed' }
  }

  // Other feeds share the placeholder: move only this one, onto the existing site or a new one.
  const targetId = await db.transaction((tx) => moveFeedToOriginSite(tx, feed, declared))
  if (targetId === site.id) return { siteId: site.id, outcome: 'kept' }
  return { siteId: targetId, outcome: target ? 'joined' : 'split' }
}

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

/**
 * The id of the feed this one permanently redirects onto, when adopting that verdict costs
 * nobody anything: the destination exists, it is not us, and no member subscribes to this row.
 */
async function aliasOf(db: Db, feed: FeedRow, destination: string): Promise<number | null> {
  const [other] = await db
    .select({ id: feeds.id })
    .from(feeds)
    .where(eq(feeds.feedUrl, destination))
  if (!other || other.id === feed.id) return null
  const [subscriber] = await db
    .select({ feedId: subscriptions.feedId })
    .from(subscriptions)
    .where(eq(subscriptions.feedId, feed.id))
    .limit(1)
  return subscriber ? null : other.id
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
  // Store the clean interval and jitter only the wake-up time. Jittering the stored value too
  // fed it back in as `currentSec` on the next fetch, so the ±10% compounded on every backoff
  // step and the column ratcheted past the 24h clamp instead of settling at it.
  const interval = nextIntervalSec({
    currentSec: feed.fetchIntervalSec,
    itemsLast7d: count,
    hadNewItems: args.hadNewItems,
    floorSec: args.floorSec,
  })
  const set = {
    errorCount: 0,
    timeoutStreak: 0,
    lastError: null,
    lastFetchedAt: now,
    nextFetchAt: addSeconds(now, withJitter(interval, opts.random)),
    fetchIntervalSec: interval,
    ...args.extra,
  }

  // `last_body_hash` is a promise that the stored articles reflect that body, and the next fetch
  // skips everything when it matches. Two fetches of one feed each write their own articles and
  // their own hash in separate commits, so an older body can land on the article after a newer
  // one recorded its hash, and the stale copy then survives until the feed changes again.
  //
  // Claim the hash only while nothing else has completed a fetch since we read the row. The
  // loser of that check clears the hash instead, so the next fetch reprocesses and repairs
  // whatever the interleaving left -- and because the loser writes after the winner, a concurrent
  // pair always settles on the clearing write.
  if (set.lastBodyHash !== undefined && set.lastBodyHash !== null) {
    const claimed = await db
      .update(feeds)
      .set(set)
      .where(
        and(
          eq(feeds.id, feed.id),
          feed.lastFetchedAt === null
            ? isNull(feeds.lastFetchedAt)
            : eq(feeds.lastFetchedAt, feed.lastFetchedAt),
        ),
      )
      .returning({ id: feeds.id })
    if (claimed.length > 0) return
    await db
      .update(feeds)
      .set({ ...set, lastBodyHash: null })
      .where(eq(feeds.id, feed.id))
    return
  }

  await db.update(feeds).set(set).where(eq(feeds.id, feed.id))
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

  const columns = {
    id: articles.id,
    contentHash: articles.contentHash,
    contentVersion: articles.contentVersion,
  }
  let existing = (
    await db
      .select(columns)
      .from(articles)
      .where(and(eq(articles.feedId, feed.id), eq(articles.dedupKey, key)))
  )[0]

  if (!existing) {
    // Held in an object because it is assigned inside the transaction callback, where
    // control-flow narrowing on a plain `let` would not follow.
    const stored: { id?: number } = {}
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
        // Two fetches of one feed can run at once -- a retry beside its own active job, since
        // pg-boss's `short` policy dedups `created` jobs only, or a hand-run command beside the
        // scheduler. Both then insert the same items, and without this the loser threw and lost
        // the whole fetch. Jobs have to be idempotent (ADR 0004), which includes against
        // themselves.
        .onConflictDoNothing({ target: [articles.feedId, articles.dedupKey] })
        .returning({ id: articles.id })
      // No row means the other fetch got there first: it stored the content and queued the
      // translation, so this one must not count the article again or queue it twice.
      if (!row) return
      const id = (row as { id: number }).id
      stored.id = id
      await tx.insert(articleContents).values({
        articleId: id,
        html: processed.html,
        blocks: processed.blocks,
        extractedFrom: 'feed',
      })
      if (onStored) await onStored(tx, { id, sourceLang, kind: 'inserted' })
    })
    if (stored.id !== undefined) return { kind: 'inserted', id: stored.id }
    // The other fetch inserted it between our select and our insert. Re-read and carry on as if
    // it had been there all along: reporting `unchanged` without comparing content would lose
    // this fetch's version of the item whenever the two fetches read different bodies, and
    // silently — the feed's body hash is recorded on the way out, so an identical body later
    // short-circuits before ever reaching the article again.
    existing = (
      await db
        .select(columns)
        .from(articles)
        .where(and(eq(articles.feedId, feed.id), eq(articles.dedupKey, key)))
    )[0]
    if (!existing) return { kind: 'unchanged', id: null }
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
  const [loaded] = await db.select().from(feeds).where(eq(feeds.id, feedId))
  if (!loaded) return { status: 'skipped', reason: 'feed not found' }
  if (loaded.status !== 'active') return { status: 'skipped', reason: `feed is ${loaded.status}` }
  let feed: FeedRow = loaded

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

  // A permanent redirect onto a URL another feed already holds means this row is an alias of
  // that feed. Decide it here, the moment the redirect is known and before anything is written:
  // everything below would store a second copy of every post and queue a translation for each,
  // and a 304 would return without ever looking at the redirect at all.
  //
  // A feed somebody subscribes to is left alone — skipping its articles would empty the blog for
  // its readers — and keeps its own URL through the collision guard further down.
  if (res.permanentRedirectTo) {
    const alias = await aliasOf(db, feed, res.permanentRedirectTo)
    if (alias !== null) {
      // Still record the visit, or the scheduler re-runs this every tick.
      await recordSuccess(db, feed, now, { hadNewItems: false, floorSec: null }, opts)
      return { status: 'skipped', reason: 'duplicate', duplicateOf: alias }
    }
  }

  // Provenance is judged only on responses proven to be this feed: a valid 304, a body already
  // parsed and stored, or a body that parses now. A redirect that ends in an error page or a
  // login form says nothing about where the feed lives and must not move it.
  if (res.status === 304) {
    feed = (await enforceProvenance(db, feed, normalizeOrigin(res.finalUrl))).feed
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
    feed = (await enforceProvenance(db, feed, normalizeOrigin(res.finalUrl))).feed
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

  // Before a single article is stored: the feed belongs to the origin that served it.
  const provenance = await enforceProvenance(db, feed, normalizeOrigin(res.finalUrl))
  feed = provenance.feed

  const samples: ContentSample[] = []
  const newArticleIds: number[] = []
  const updatedArticleIds: number[] = []
  const items = selectItems(parsed.items)
  for (const item of items) {
    const outcome = await upsertArticle(db, feed, parsed, item, now, samples, opts.onArticleStored)
    if (outcome.kind === 'inserted' && outcome.id !== null) newArticleIds.push(outcome.id)
    else if (outcome.kind === 'updated' && outcome.id !== null) updatedArticleIds.push(outcome.id)
  }
  const newArticles = newArticleIds.length
  const updatedArticles = updatedArticleIds.length

  const adopted = await adoptDeclaredHome(db, feed, parsed.homeUrl)
  const siteId = adopted.siteId
  const siteHome: HomeUrlOutcome = provenance.detached ? 'detached' : adopted.outcome

  // Fill in site metadata the feed knows and the site row lacks. The language comes from what
  // the site's articles are written in; feeds declare "zh", "en-us", or nothing at all, so the
  // declared tag is only a normalized fallback while no article has been detected yet.
  const [dominant] = await db.execute<{ lang: string | null }>(sql`
    select mode() within group (order by a.source_lang) as lang
    from articles a join feeds f on f.id = a.feed_id
    where f.site_id = ${siteId} and a.source_lang is not null
  `)
  const primaryLang = dominant?.lang ?? normalizeLangTag(parsed.language)
  await db
    .update(sites)
    .set({
      title: sql`coalesce(${sites.title}, ${parsed.title})`,
      description: sql`coalesce(${sites.description}, ${parsed.description})`,
      primaryLang: sql`coalesce(${primaryLang}::text, ${sites.primaryLang})`,
    })
    .where(eq(sites.id, siteId))

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

  // Held in an object because it is assigned inside the catch below, where control-flow
  // narrowing on a plain `let` would not follow.
  const duplicate: { of?: number } = {}
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
    //
    // The constraint name lives on the driver error's `cause`, never in its message -- the
    // message is drizzle's "Failed query: ..." -- so matching on String(err) never fired and
    // this recovery was dead from the day it was written. `social.ts` reads the same shape.
    const cause = (err as { cause?: { code?: string; constraint_name?: string } }).cause
    const collision = cause?.code === '23505' && cause?.constraint_name === 'feeds_feed_url_key'
    if (res.permanentRedirectTo && collision) {
      const [other] = await db
        .select({ id: feeds.id })
        .from(feeds)
        .where(eq(feeds.feedUrl, res.permanentRedirectTo))
      if (other) duplicate.of = other.id
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
    itemsSkipped: parsed.items.length - items.length,
    newArticleIds,
    updatedArticleIds,
    siteHome,
    ...(duplicate.of === undefined ? {} : { duplicateOf: duplicate.of }),
  }
}

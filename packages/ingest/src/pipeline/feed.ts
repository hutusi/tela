/**
 * Fetch one feed under its lease and store what changed: versions, content objects, the feed's
 * schedule, and the site's metadata, all in one fenced batch (ADRs 0021, 0022).
 *
 * The lease is the whole concurrency story. Two fetches of one feed cannot run at once, so there
 * is no insert race to survive and no body-hash compare-and-swap. A holder that stalled past its
 * lease finds the fence refusing its batch and writes nothing. Follow-up work (title
 * translations, extraction, favicons, WebSub) is recorded as state for the sweeps to find, never
 * queued from here.
 */
import {
  buildContentObject,
  type ContentObject,
  dedupKey,
  FeedParseError,
  normalizeLangTag,
  normalizeOrigin,
  objectKeys,
  type ParsedFeed,
  type ParsedItem,
  parseFeedText,
  processArticleHtml,
  sha256Hex,
} from '@tela/content'
import {
  type ArticleChange,
  aliasTarget,
  chooseCurrent,
  type ExistingArticle,
  existingArticles,
  type FeedForFetch,
  feedIsVouched,
  fillSiteMetadata,
  first,
  insertArticles,
  insertVersions,
  type Lease,
  loadFeedForFetch,
  mergeFeed,
  moveFeedToOrigin,
  type NewArticle,
  type NewVersion,
  noteHub,
  recentArticleCount,
  replayIfRejected,
  type StoredVersion,
  siteFeedPosts,
  updateArticles,
  updateFeed,
  wantsExtraction,
} from '@tela/data'
import type { ContentMode } from '@tela/shared'
import { sql } from 'drizzle-orm'
import {
  type ContentSample,
  endsWithJumpLink,
  learnContentMode,
  SUMMARY_MAX_CHARS,
} from '../content-mode'
import { HttpError } from '../http'
import { FEED_MAX_BYTES, selectItems, titleFor } from '../items'
import { timeoutsWarrantRelay } from '../region-policy'
import {
  backoffSec,
  cacheControlMaxAge,
  DEAD_AFTER_ERRORS,
  nextIntervalSec,
  parseRetryAfter,
  withJitter,
} from '../schedule'
import { newWebsubSecret } from '../websub'
import { commit, type IngestContext, type Statement } from './context'
import { planMerge } from './merge'

export type HomeUrlOutcome = 'kept' | 'renamed' | 'joined' | 'split' | 'blocked' | 'detached'

export type IngestFeedResult =
  | {
      status: 'fetched'
      newArticleIds: number[]
      updatedArticleIds: number[]
      items: number
      /** Items beyond MAX_ITEMS_PER_FETCH, left alone this time. */
      itemsSkipped: number
      siteHome: HomeUrlOutcome
    }
  | { status: 'unchanged' }
  | { status: 'error'; kind: string; error: string }
  | { status: 'dead'; error: string }
  | { status: 'skipped'; reason: string; duplicateOf?: number }
  /** The lease expired and another holder owns the feed; nothing was written. */
  | { status: 'lost' }

const DAY_MS = 24 * 3600 * 1000
const IMMUTABLE = 'public, max-age=31536000, immutable'

async function finish(
  ctx: IngestContext,
  lease: Lease,
  statements: Statement[],
  result: IngestFeedResult,
): Promise<IngestFeedResult> {
  const committed = await commit(ctx, lease, statements)
  return committed.ok ? result : { status: 'lost' }
}

function recordError(
  ctx: IngestContext,
  lease: Lease,
  feed: FeedForFetch,
  kind: string,
  message: string,
  now: number,
  opts: { retryAfterSec?: number | null; dead?: boolean } = {},
): Promise<IngestFeedResult> {
  const errorCount = feed.errorCount + 1
  const dead = opts.dead || errorCount >= DEAD_AFTER_ERRORS
  const delaySec = opts.retryAfterSec ?? backoffSec(feed.fetchIntervalSec, errorCount)
  const set = {
    errorCount,
    timeoutStreak: kind === 'timeout' ? feed.timeoutStreak + 1 : 0,
    lastError: `${kind}: ${message}`.slice(0, 500),
    lastFetchedAt: now,
    nextFetchAt: now + delaySec * 1000,
    status: dead ? ('dead' as const) : feed.status,
  }
  return finish(
    ctx,
    lease,
    [updateFeed(ctx.db, feed.id, set, now)],
    dead ? { status: 'dead', error: message } : { status: 'error', error: message, kind },
  )
}

/** The feed row after a successful visit. The interval is stored clean; only the wake-up jitters. */
function successSet(
  ctx: IngestContext,
  feed: FeedForFetch,
  now: number,
  startedAt: number,
  args: { hadNewItems: boolean; floorSec: number | null; itemsLast7d: number },
) {
  const interval = nextIntervalSec({
    currentSec: feed.fetchIntervalSec,
    itemsLast7d: args.itemsLast7d,
    hadNewItems: args.hadNewItems,
    floorSec: args.floorSec,
  })
  return {
    errorCount: 0,
    timeoutStreak: 0,
    lastError: null,
    lastFetchedAt: now,
    nextFetchAt: now + withJitter(interval, ctx.random) * 1000,
    fetchIntervalSec: interval,
    // A ping that arrived after this fetch began still stands; one from before is answered.
    refetchRequestedAt: sql<
      number | null
    >`case when refetch_requested_at <= ${startedAt} then null else refetch_requested_at end`,
  }
}

/**
 * The feed belongs to the origin that served it (ADR 0011). On a claimed site that does not vouch
 * for it, move it to the served origin's site before anything is stored under the member's name.
 */
function provenance(
  ctx: IngestContext,
  feed: FeedForFetch,
  servedOrigin: string | null,
  now: number,
): { statements: Statement[]; detached: boolean } {
  const statements: Statement[] = []
  if (servedOrigin && servedOrigin !== feed.servedOrigin) {
    statements.push(updateFeed(ctx.db, feed.id, { servedOrigin }, now))
  }
  const current = { ...feed, servedOrigin: servedOrigin ?? feed.servedOrigin }
  if (!servedOrigin || feedIsVouched(current, feed.site)) return { statements, detached: false }
  statements.push(...moveFeedToOrigin(ctx.db, feed, servedOrigin, now))
  return { statements, detached: true }
}

/**
 * A feed added by URL starts on a placeholder site keyed by its own origin. Once it declares its
 * home, move it there: rename the placeholder when it is the only feed and the home is free,
 * otherwise join an unclaimed site for that home or split onto a new one. A claimed placeholder
 * or a claimed target is left alone.
 */
async function adoptDeclaredHome(
  ctx: IngestContext,
  feed: FeedForFetch,
  declaredHome: string | null,
  now: number,
): Promise<{ statements: Statement[]; outcome: HomeUrlOutcome }> {
  const declared = declaredHome ? normalizeOrigin(declaredHome) : null
  const site = feed.site
  const keyedByFeedHost = site.homeUrl === normalizeOrigin(feed.feedUrl)
  if (!declared || declared === site.homeUrl || !keyedByFeedHost) {
    return { statements: [], outcome: 'kept' }
  }
  if (site.claimedBy !== null) return { statements: [], outcome: 'blocked' }
  const { db } = ctx
  const target = await first<{ id: number; claimed_by: string | null }>(
    db,
    sql`select id, claimed_by from sites where home_url = ${declared}`,
  )
  if (target?.claimed_by) return { statements: [], outcome: 'blocked' }
  const siblings = await first<{ n: number }>(
    db,
    sql`select count(*) as n from feeds where site_id = ${site.id} and id <> ${feed.id}`,
  )
  if (!target && (siblings?.n ?? 0) === 0) {
    return {
      statements: [
        db.run(sql`
          update sites set home_url = ${declared}, updated_at = ${now},
            seq = (select v from counters where k = 'seq')
          where id = ${site.id} and not exists (select 1 from sites where home_url = ${declared})
        `),
      ],
      outcome: 'renamed',
    }
  }
  return {
    statements: [...moveFeedToOrigin(db, feed, declared, now)],
    outcome: target ? 'joined' : 'split',
  }
}

/** What the plan needs of an item: its content object and raw HTML are written and let go. */
type ProcessedItem = {
  item: ParsedItem
  baseUrl: string
  key: string
  title: string
  sourceLang: string | null
  contentKey: string
  excerpt: string | null
  bodyChars: number
  wordCount: number
  readingMinutes: number
  rawSha: string
  sample: ContentSample
}

async function processItem(
  item: ParsedItem,
  key: string,
  feed: FeedForFetch,
  parsed: ParsedFeed,
): Promise<{ p: ProcessedItem; object: ContentObject; rawHtml: string }> {
  const html = item.contentHtml ?? item.summaryHtml ?? ''
  // What relative links resolve against: kept with the version, since the feed's own address can
  // move later, and `article.reprocess` must make the body against the base it was first made on.
  const baseUrl = item.url ?? feed.feedUrl
  const processed = await processArticleHtml({
    html,
    baseUrl,
    // The blog's own majority before the feed's declared tag, which is sometimes a template's
    // default (a Chinese blog declaring `en-US`). A hint only breaks near ties.
    langHint: item.language ?? feed.site.primaryLang ?? parsed.language,
    title: item.title,
  })
  const object = buildContentObject(processed)
  const p: ProcessedItem = {
    item,
    baseUrl,
    key,
    title: titleFor(item, processed.excerpt),
    sourceLang: processed.lang === 'und' ? null : processed.lang,
    contentKey: object.key,
    excerpt: processed.excerpt || null,
    bodyChars: processed.text.length,
    wordCount: processed.wordCount,
    readingMinutes: processed.readingMinutes,
    rawSha: await sha256Hex(html),
    sample: {
      chars: processed.text.length,
      hadFullContent: item.contentHtml !== null,
      tail: processed.text.slice(-40),
      jumpLink: endsWithJumpLink(html, item.url),
    },
  }
  return { p, object, rawHtml: html }
}

async function titleHashOf(title: string, excerpt: string | null): Promise<string> {
  return (await sha256Hex(`${title}\n${excerpt ?? ''}`)).slice(0, 16)
}

function hostOf(url: string | null): string | null {
  if (!url) return null
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return null
  }
}

function asStored(p: ProcessedItem, version: number): StoredVersion {
  return {
    version,
    provenance: 'feed',
    contentKey: p.contentKey,
    bodyChars: p.bodyChars,
    excerpt: p.excerpt,
    wordCount: p.wordCount,
    readingMinutes: p.readingMinutes,
    lang: p.sourceLang,
  }
}

function newVersion(p: ProcessedItem, version: number): NewVersion {
  return {
    dedupKey: p.key,
    version,
    provenance: 'feed',
    contentKey: p.contentKey,
    rawKey: objectKeys.raw(p.rawSha),
    bodyChars: p.bodyChars,
    excerpt: p.excerpt,
    wordCount: p.wordCount,
    readingMinutes: p.readingMinutes,
    lang: p.sourceLang,
    // Where the body came from and what its links resolve against: the item, or for an item with
    // no link of its own, the feed as it was then.
    sourceUrl: p.baseUrl,
  }
}

/**
 * An item that brings its article nothing: the article's latest *feed* version holds this very
 * content, or the item has no body. Compared with whatever is current, a summary was compared
 * with its own extraction and put back (the regression ADR 0022 fixes). A new article is never
 * unchanged.
 */
function unchanged(p: ProcessedItem, prior: ExistingArticle | undefined): boolean {
  if (!prior) return false
  const latestFeed = prior.versions
    .filter((v) => v.provenance === 'feed')
    .reduce<StoredVersion | undefined>((a, v) => (!a || v.version > a.version ? v : a), undefined)
  return latestFeed?.contentKey === p.contentKey || p.bodyChars === 0
}

/** Decide what each item means for its article: new, changed (with a new current), or unchanged. */
async function plan(
  processed: ProcessedItem[],
  existing: Map<string, ExistingArticle>,
  mode: ContentMode,
) {
  const inserts: NewArticle[] = []
  const versions: NewVersion[] = []
  const changes: ArticleChange[] = []
  for (const p of processed) {
    const prior = existing.get(p.key)
    if (!prior) {
      inserts.push({
        dedupKey: p.key,
        url: p.item.url,
        urlHost: hostOf(p.item.url),
        title: p.title,
        author: p.item.author,
        publishedAt: p.item.publishedAt?.getTime() ?? null,
        sourceLang: p.sourceLang,
        excerpt: p.excerpt,
        contentKey: p.contentKey,
        wordCount: p.wordCount,
        readingMinutes: p.readingMinutes,
        extractState: wantsExtraction([asStored(p, 1)], mode, SUMMARY_MAX_CHARS) ? 'due' : 'none',
        titleHash: await titleHashOf(p.title, p.excerpt),
      })
      versions.push(newVersion(p, 1))
      continue
    }
    if (unchanged(p, prior)) continue
    const next = Math.max(0, ...prior.versions.map((v) => v.version)) + 1
    const all = [...prior.versions, asStored(p, next)]
    const current = (chooseCurrent(all, mode) ?? asStored(p, next)) as StoredVersion
    const wants = wantsExtraction(all, mode, SUMMARY_MAX_CHARS)
    changes.push({
      id: prior.id,
      expectVersion: prior.currentVersion,
      url: p.item.url,
      urlHost: hostOf(p.item.url),
      title: p.title,
      author: p.item.author,
      publishedAt: p.item.publishedAt?.getTime() ?? null,
      sourceLang: current.lang,
      excerpt: current.excerpt,
      currentVersion: current.version,
      contentKey: current.contentKey,
      wordCount: current.wordCount,
      readingMinutes: current.readingMinutes,
      extractState: wants ? 'due' : prior.extractState === 'due' ? 'none' : prior.extractState,
      titleHash: await titleHashOf(p.title, current.excerpt),
    })
    versions.push(newVersion(p, next))
  }
  return { inserts, versions, changes }
}

/**
 * Writes an item's objects as it is processed, eight puts at a time, before the batch that
 * references them; an orphan from a failed batch is harmless. Held until the batch instead, every
 * item's content object and raw HTML cost about 13 times the feed: danluu.com's 6.6 MB feed took
 * 85 MB of the isolate's 128 (V8, measured), and 35 MB written as it went.
 */
function objectWriter(ctx: IngestContext) {
  const seen = new Set<string>()
  let puts: (() => Promise<void>)[] = []
  const flush = async () => {
    const now = puts
    puts = []
    await Promise.all(now.map((f) => f()))
  }
  return {
    async put(p: ProcessedItem, object: ContentObject, rawHtml: string) {
      if (!seen.has(p.contentKey)) {
        seen.add(p.contentKey)
        puts.push(() =>
          ctx.blobs.put(objectKeys.content(p.contentKey), JSON.stringify(object), {
            contentType: 'application/json',
            cacheControl: IMMUTABLE,
          }),
        )
      }
      if (!seen.has(p.rawSha)) {
        seen.add(p.rawSha)
        puts.push(() =>
          ctx.blobs.put(objectKeys.raw(p.rawSha), rawHtml, {
            contentType: 'text/html; charset=utf-8',
          }),
        )
      }
      if (puts.length >= 8) await flush()
    },
    flush,
  }
}

/** Fetch a feed and store what changed. `lease.key` is the feed id. */
export async function ingestFeed(ctx: IngestContext, lease: Lease): Promise<IngestFeedResult> {
  const { db } = ctx
  const startedAt = ctx.clock.now()
  const feed = await loadFeedForFetch(db, Number(lease.key))
  if (!feed) return finish(ctx, lease, [], { status: 'skipped', reason: 'feed not found' })
  if (feed.status !== 'active') {
    return finish(ctx, lease, [], { status: 'skipped', reason: `feed is ${feed.status}` })
  }
  // Another address for a feed of the same blog (ADR 0028): hand over to it instead of fetching.
  if (feed.site.otherFeeds > 0) {
    const merge = planMerge(feed, feed.site.homeUrl, await siteFeedPosts(db, feed.site.id))
    if (merge) {
      return finish(ctx, lease, [...mergeFeed(db, { alias: feed.id, ...merge }, startedAt)], {
        status: 'skipped',
        reason: 'merged',
        duplicateOf: merge.target,
      })
    }
  }

  let res: Awaited<ReturnType<IngestContext['http']['get']>>
  try {
    res = await ctx.http.get(feed.feedUrl, {
      etag: feed.etag,
      lastModified: feed.lastModified,
      region: feed.fetchRegion,
      maxBytes: FEED_MAX_BYTES,
    })
  } catch (err) {
    if (!(err instanceof HttpError)) throw err
    const now = ctx.clock.now()
    const policy = ctx.region
    if (
      err.kind === 'timeout' &&
      policy &&
      timeoutsWarrantRelay(feed, policy) &&
      (await policy.controlOk())
    ) {
      // The origin keeps timing out while our own connectivity is fine: route it through the
      // relay from now on and retry at the next tick.
      const streak = feed.timeoutStreak + 1
      return finish(
        ctx,
        lease,
        [
          updateFeed(
            db,
            feed.id,
            {
              fetchRegion: 'cn',
              regionFlippedAt: now,
              timeoutStreak: 0,
              errorCount: feed.errorCount + 1,
              lastError: `timeout: routed through the relay after ${streak} timeouts`,
              lastFetchedAt: now,
              nextFetchAt: now,
            },
            now,
          ),
        ],
        { status: 'error', error: 'routed through the relay', kind: 'region_flip' },
      )
    }
    return recordError(ctx, lease, feed, err.kind, err.message, now)
  }

  const now = ctx.clock.now()
  const floorFromHeaders = cacheControlMaxAge(res.headers.get('cache-control'))
  const itemsLast7d = await recentArticleCount(db, feed.id, now - 7 * DAY_MS)

  // A permanent redirect onto a URL another feed holds makes this row an alias. Decide before
  // anything is written; a feed somebody reads keeps working and keeps its own URL.
  let redirectTargetExists = false
  if (res.permanentRedirectTo) {
    const target = await aliasTarget(db, feed.id, res.permanentRedirectTo)
    redirectTargetExists = target.exists
    if (target.alias !== null) {
      const set = successSet(ctx, feed, now, startedAt, {
        hadNewItems: false,
        floorSec: null,
        itemsLast7d,
      })
      return finish(ctx, lease, [updateFeed(db, feed.id, set, now)], {
        status: 'skipped',
        reason: 'duplicate',
        duplicateOf: target.alias,
      })
    }
  }

  const served = normalizeOrigin(res.finalUrl)
  if (res.status === 304) {
    const moved = provenance(ctx, feed, served, now)
    const set = successSet(ctx, feed, now, startedAt, {
      hadNewItems: false,
      floorSec: floorFromHeaders,
      itemsLast7d,
    })
    return finish(ctx, lease, [...moved.statements, updateFeed(db, feed.id, set, now)], {
      status: 'unchanged',
    })
  }
  if (res.status === 429 || res.status === 503) {
    const retryAfterSec = parseRetryAfter(res.headers.get('retry-after'), new Date(now))
    return recordError(ctx, lease, feed, `http_${res.status}`, 'rate limited', now, {
      retryAfterSec,
    })
  }
  if (res.status === 410)
    return recordError(ctx, lease, feed, 'http_410', 'gone', now, { dead: true })
  if (res.status !== 200) {
    return recordError(
      ctx,
      lease,
      feed,
      `http_${res.status}`,
      `unexpected status ${res.status}`,
      now,
    )
  }

  const bodyHash = await sha256Hex(res.body)
  if (bodyHash === feed.lastBodyHash) {
    const moved = provenance(ctx, feed, served, now)
    const set = {
      ...successSet(ctx, feed, now, startedAt, {
        hadNewItems: false,
        floorSec: floorFromHeaders,
        itemsLast7d,
      }),
      etag: res.headers.get('etag'),
      lastModified: res.headers.get('last-modified'),
    }
    return finish(ctx, lease, [...moved.statements, updateFeed(db, feed.id, set, now)], {
      status: 'unchanged',
    })
  }

  let parsed: ParsedFeed
  try {
    parsed = parseFeedText(res.body, res.finalUrl)
  } catch (err) {
    if (err instanceof FeedParseError)
      return recordError(ctx, lease, feed, 'parse', err.message, now)
    throw err
  }

  // Provenance first: the feed belongs to the origin that served it before a post is stored.
  const moved = provenance(ctx, feed, served, now)
  const items = selectItems(parsed.items)
  // Which article each item is, before any body is made: an item's objects are then written as it
  // is processed and let go (`objectWriter`), never held for the whole feed.
  const keys: string[] = []
  for (const item of items) keys.push(await dedupKey(item))
  const existing = await existingArticles(db, feed.id, keys)
  const writer = objectWriter(ctx)
  const processed: ProcessedItem[] = []
  for (const [i, item] of items.entries()) {
    const { p, object, rawHtml } = await processItem(item, keys[i] as string, feed, parsed)
    if (!unchanged(p, existing.get(p.key))) await writer.put(p, object, rawHtml)
    processed.push(p)
  }
  await writer.flush()

  const contentMode: ContentMode =
    feed.contentMode === 'unknown'
      ? learnContentMode(processed.map((p) => p.sample))
      : feed.contentMode
  const planned = await plan(processed, existing, contentMode)

  const adopted = moved.detached
    ? { statements: [] as Statement[], outcome: 'detached' as const }
    : await adoptDeclaredHome(ctx, feed, parsed.homeUrl, now)

  const published = parsed.items
    .map((i) => i.publishedAt?.getTime())
    .filter((t): t is number => t !== undefined)
  const lastItemAt = published.length > 0 ? Math.max(...published) : feed.lastItemAt
  const floors = [parsed.ttlMinutes ? parsed.ttlMinutes * 60 : null, floorFromHeaders]
  const floorSec = floors.reduce<number | null>(
    (acc, f) => (f && (!acc || f > acc) ? f : acc),
    null,
  )
  const newInWindow = planned.inserts.filter(
    (a) => (a.publishedAt ?? now) > now - 7 * DAY_MS,
  ).length
  // Another address of a feed its blog already has merges as a fetch starts, once it holds posts
  // to compare (ADR 0028). Until then its readers have the blog twice, so after the first fetch
  // that stores them it is due again at the next tick, not an interval later: an OPML import
  // naming `/feed.xml` for a blog followed at `/feed` showed it twice for a day.
  const mayBeAlias =
    feed.lastBodyHash === null && (feed.site.otherFeeds > 0 || adopted.outcome === 'joined')

  const feedSet = {
    ...successSet(ctx, feed, now, startedAt, {
      hadNewItems: planned.inserts.length > 0,
      floorSec,
      itemsLast7d: itemsLast7d + newInWindow,
    }),
    etag: res.headers.get('etag'),
    lastModified: res.headers.get('last-modified'),
    lastBodyHash: bodyHash,
    format: parsed.format,
    title: parsed.title ?? feed.title,
    description: parsed.description ?? feed.description,
    hubUrl: parsed.hubUrl,
    contentMode,
    lastItemAt,
    // A permanent redirect onto a URL another feed already holds keeps our own URL.
    feedUrl:
      res.permanentRedirectTo && !redirectTargetExists ? res.permanentRedirectTo : feed.feedUrl,
    ...(mayBeAlias ? { nextFetchAt: now } : {}),
  }

  const statements: Statement[] = [...moved.statements]
  if (planned.inserts.length > 0) statements.push(insertArticles(db, feed.id, planned.inserts, now))
  if (planned.versions.length > 0)
    statements.push(insertVersions(db, feed.id, planned.versions, now))
  // After the versions: an article moves only onto a row that holds its new content (`pointAt`).
  if (planned.changes.length > 0) statements.push(updateArticles(db, planned.changes))
  statements.push(...adopted.statements)
  statements.push(
    fillSiteMetadata(
      db,
      feed.id,
      {
        title: parsed.title,
        description: parsed.description,
        declaredLang: normalizeLangTag(parsed.language),
      },
      now,
    ),
  )
  statements.push(updateFeed(db, feed.id, feedSet, now))
  // After the feed's update, which saved its validators: a change another writer beat is fetched
  // again rather than lost behind a 304.
  if (planned.changes.length > 0) {
    statements.push(replayIfRejected(db, feed.id, planned.changes, now))
  }
  if (ctx.websub && parsed.hubUrl) {
    statements.push(noteHub(db, feed, parsed.hubUrl, newWebsubSecret(), now))
  }

  const committed = await commit(ctx, lease, statements)
  if (!committed.ok) return { status: 'lost' }
  // fence, bumpSeq, then our statements: the insert's RETURNING is at a known index.
  const insertIndex = 2 + moved.statements.length
  const inserted =
    planned.inserts.length > 0
      ? ((committed.results[insertIndex] as { id: number }[] | undefined) ?? [])
      : []
  return {
    status: 'fetched',
    newArticleIds: inserted.map((r) => r.id),
    updatedArticleIds: planned.changes.map((c) => c.id),
    items: parsed.items.length,
    itemsSkipped: parsed.items.length - items.length,
    siteHome: adopted.outcome,
  }
}

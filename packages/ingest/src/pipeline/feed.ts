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
  type StoredVersion,
  siteFeedPosts,
  updateArticles,
  updateFeed,
  wantsExtraction,
} from '@tela/data'
import type { ContentMode } from '@tela/shared'
import { sql } from 'drizzle-orm'
import { type ContentSample, learnContentMode, SUMMARY_MAX_CHARS } from '../content-mode'
import { HttpError } from '../http'
import { selectItems, titleFor } from '../items'
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

type ProcessedItem = {
  item: ParsedItem
  key: string
  title: string
  sourceLang: string | null
  object: ContentObject
  excerpt: string | null
  bodyChars: number
  wordCount: number
  readingMinutes: number
  rawHtml: string
  rawSha: string
  sample: ContentSample
}

async function processItem(item: ParsedItem, feed: FeedForFetch, parsed: ParsedFeed) {
  const html = item.contentHtml ?? item.summaryHtml ?? ''
  const processed = await processArticleHtml({
    html,
    baseUrl: item.url ?? feed.feedUrl,
    // The blog's own majority before the feed's declared tag, which is sometimes a template's
    // default (a Chinese blog declaring `en-US`). A hint only breaks near ties.
    langHint: item.language ?? feed.site.primaryLang ?? parsed.language,
    title: item.title,
  })
  return {
    item,
    key: await dedupKey(item),
    title: titleFor(item, processed.excerpt),
    sourceLang: processed.lang === 'und' ? null : processed.lang,
    object: buildContentObject(processed),
    excerpt: processed.excerpt || null,
    bodyChars: processed.text.length,
    wordCount: processed.wordCount,
    readingMinutes: processed.readingMinutes,
    rawHtml: html,
    rawSha: await sha256Hex(html),
    sample: {
      chars: processed.text.length,
      hadFullContent: item.contentHtml !== null,
      tail: processed.text.slice(-40),
    },
  } satisfies ProcessedItem
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
    contentKey: p.object.key,
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
    contentKey: p.object.key,
    rawKey: objectKeys.raw(p.rawSha),
    bodyChars: p.bodyChars,
    excerpt: p.excerpt,
    wordCount: p.wordCount,
    readingMinutes: p.readingMinutes,
    lang: p.sourceLang,
    sourceUrl: p.item.url,
  }
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
  const written: ProcessedItem[] = []
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
        contentKey: p.object.key,
        wordCount: p.wordCount,
        readingMinutes: p.readingMinutes,
        extractState: wantsExtraction([asStored(p, 1)], mode, SUMMARY_MAX_CHARS) ? 'due' : 'none',
        titleHash: await titleHashOf(p.title, p.excerpt),
      })
      versions.push(newVersion(p, 1))
      written.push(p)
      continue
    }
    // Compare with the latest *feed* version only. Comparing with whatever is current compared a
    // summary with its own extraction, and put the summary back (the regression ADR 0022 fixes).
    const latestFeed = prior.versions
      .filter((v) => v.provenance === 'feed')
      .reduce<StoredVersion | undefined>((a, v) => (!a || v.version > a.version ? v : a), undefined)
    if (latestFeed?.contentKey === p.object.key || p.bodyChars === 0) continue
    const next = Math.max(0, ...prior.versions.map((v) => v.version)) + 1
    const all = [...prior.versions, asStored(p, next)]
    const current = (chooseCurrent(all, mode) ?? asStored(p, next)) as StoredVersion
    const wants = wantsExtraction(all, mode, SUMMARY_MAX_CHARS)
    changes.push({
      id: prior.id,
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
    written.push(p)
  }
  return { inserts, versions, changes, written }
}

/** Write objects before the batch that references them; an orphan from a failed batch is harmless. */
async function putObjects(ctx: IngestContext, items: ProcessedItem[]): Promise<void> {
  const puts: (() => Promise<void>)[] = []
  const seen = new Set<string>()
  for (const p of items) {
    if (!seen.has(p.object.key)) {
      seen.add(p.object.key)
      puts.push(() =>
        ctx.blobs.put(objectKeys.content(p.object.key), JSON.stringify(p.object), {
          contentType: 'application/json',
          cacheControl: IMMUTABLE,
        }),
      )
    }
    if (!seen.has(p.rawSha)) {
      seen.add(p.rawSha)
      puts.push(() =>
        ctx.blobs.put(objectKeys.raw(p.rawSha), p.rawHtml, {
          contentType: 'text/html; charset=utf-8',
        }),
      )
    }
  }
  for (let i = 0; i < puts.length; i += 8) await Promise.all(puts.slice(i, i + 8).map((f) => f()))
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
  const processed: ProcessedItem[] = []
  for (const item of items) processed.push(await processItem(item, feed, parsed))

  const contentMode: ContentMode =
    feed.contentMode === 'unknown'
      ? learnContentMode(processed.map((p) => p.sample))
      : feed.contentMode
  const existing = await existingArticles(
    db,
    feed.id,
    processed.map((p) => p.key),
  )
  const planned = await plan(processed, existing, contentMode)
  await putObjects(ctx, planned.written)

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
  }

  const statements: Statement[] = [...moved.statements]
  if (planned.inserts.length > 0) statements.push(insertArticles(db, feed.id, planned.inserts, now))
  if (planned.changes.length > 0) statements.push(updateArticles(db, planned.changes))
  if (planned.versions.length > 0)
    statements.push(insertVersions(db, feed.id, planned.versions, now))
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

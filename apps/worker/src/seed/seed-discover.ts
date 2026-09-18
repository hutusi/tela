import { articles, type Db, feeds, sites } from '@tela/db'
import { curateSite, siteNeedsAssets } from '@tela/db/queries'
import { createJobSender } from '@tela/db/queue'
import { ensureFeed, type FetchFeedResult, fetchFeed, type HttpClient } from '@tela/ingest'
import type { SiteListing } from '@tela/shared'
import { eq, sql } from 'drizzle-orm'
import { QUEUES } from '../queues'
import { queueAvailable, titleEnqueuer } from '../title-jobs'
import type { CuratedSite } from './curated-sites'

export type SeedOutcome = 'created' | 'updated' | 'unchanged' | 'skipped' | 'error'

export type SeedEntryReport = {
  feedUrl: string
  outcome: SeedOutcome
  feedId: number | null
  siteId: number | null
  siteTitle: string | null
  primaryLang: string | null
  fetch: FetchFeedResult['status'] | 'not_attempted'
  errorKind?: string
  error?: string
  newArticles: number
  /** Articles on the site now, which is what decides whether it is worth showing. */
  articles: number
  titleJobs: number
  listing: SiteListing | null
  listingChanged: boolean
  topics: string[]
  topicsChanged: boolean
  curated: boolean
  reason?: 'dry_run' | 'fetch_failed' | 'no_articles' | 'rejected' | 'claimed' | 'duplicate'
  /**
   * Set when the curated URL turned out to be an alias of a feed already stored: the id it
   * duplicates. The entry still works; update the list to the canonical URL to stop paying for
   * the redirect on every run.
   */
  duplicateOf?: number
  /** Why a write would be (or was) withheld, when that is not the whole story of the entry. */
  withheld?: 'rejected' | 'claimed'
  /**
   * Set with `duplicateOf` when the alias row could not be dropped because it already holds
   * articles a member may have read, liked or recommended. Needs a human: point the list entry
   * at the canonical URL, then decide what to do with the leftover feed.
   */
  orphaned?: boolean
}

export type SeedDiscoverResult = {
  titleQueue: 'ready' | 'missing'
  entries: SeedEntryReport[]
  totals: {
    attempted: number
    curated: number
    errors: number
    newArticles: number
    titleJobs: number
  }
}

export type SeedDiscoverOptions = {
  /** Resolve and report without fetching or writing anything. */
  dryRun?: boolean
  /** First N entries in list order, for staging a large seed across runs. */
  limit?: number
  /**
   * Drop the first N entries. With `limit`, this makes a staged seed cover each blog once:
   * widening `limit` alone re-fetches every earlier entry, and a host that counts requests per
   * hour rather than bytes reads that as a misbehaving reader.
   */
  skip?: number
  /** Substring of feedUrl, for retrying the one entry that failed. */
  only?: string
  onEntry?: (report: SeedEntryReport) => void
}

function select(
  entries: readonly CuratedSite[],
  opts: SeedDiscoverOptions,
): readonly CuratedSite[] {
  const matched = opts.only
    ? entries.filter((e) => e.feedUrl.includes(opts.only as string))
    : entries
  const from = opts.skip ?? 0
  return matched.slice(from, opts.limit === undefined ? undefined : from + opts.limit)
}

type SiteFacts = {
  title: string | null
  primaryLang: string | null
  listing: SiteListing | null
  topics: string[]
  articles: number
}

/** What the card would show, and what the curation decision turns on. */
async function siteFacts(db: Db, siteId: number): Promise<SiteFacts> {
  const [site] = await db
    .select({
      title: sites.title,
      primaryLang: sites.primaryLang,
      listing: sites.listing,
      topics: sites.topics,
    })
    .from(sites)
    .where(eq(sites.id, siteId))
  const [count] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(articles)
    .innerJoin(feeds, eq(feeds.id, articles.feedId))
    .where(eq(feeds.siteId, siteId))
  return {
    title: site?.title ?? null,
    primaryLang: site?.primaryLang ?? null,
    listing: site?.listing ?? null,
    topics: site?.topics ?? [],
    articles: Number(count?.n ?? 0),
  }
}

/**
 * Apply the curated list: fetch each blog once and mark its site `featured` with the editorial
 * topics. Entries are a parameter rather than an import so tests can drive this against fixture
 * feeds.
 *
 * Idempotent by construction — a re-run answers 304, stores no articles and queues no jobs, and
 * `curateSite` skips a write that would change nothing. One bad feed never aborts the run; it is
 * reported and the loop continues.
 */
export async function seedDiscover(
  db: Db,
  http: HttpClient,
  entries: readonly CuratedSite[],
  opts: SeedDiscoverOptions = {},
): Promise<SeedDiscoverResult> {
  const chosen = select(entries, opts)
  // Title jobs belong to the fetch job, not to fetchFeed: a seeder that forgets them stores
  // articles no reader ever sees translated, and nothing retries.
  const titlesReady = opts.dryRun ? false : await queueAvailable(db, QUEUES.translateTitle)
  const assetsReady = opts.dryRun ? false : await queueAvailable(db, QUEUES.siteAssets)
  const reports: SeedEntryReport[] = []

  for (const entry of chosen) {
    const report = await seedOne(db, http, entry, opts, titlesReady, assetsReady)
    reports.push(report)
    opts.onEntry?.(report)
  }

  return {
    titleQueue: titlesReady ? 'ready' : 'missing',
    entries: reports,
    totals: {
      attempted: reports.length,
      curated: reports.filter((r) => r.curated).length,
      errors: reports.filter((r) => r.outcome === 'error').length,
      newArticles: reports.reduce((n, r) => n + r.newArticles, 0),
      titleJobs: reports.reduce((n, r) => n + r.titleJobs, 0),
    },
  }
}

async function seedOne(
  db: Db,
  http: HttpClient,
  entry: CuratedSite,
  opts: SeedDiscoverOptions,
  titlesReady: boolean,
  assetsReady: boolean,
): Promise<SeedEntryReport> {
  const base: SeedEntryReport = {
    feedUrl: entry.feedUrl,
    outcome: 'unchanged',
    feedId: null,
    siteId: null,
    siteTitle: null,
    primaryLang: null,
    fetch: 'not_attempted',
    newArticles: 0,
    articles: 0,
    titleJobs: 0,
    listing: null,
    listingChanged: false,
    topics: [],
    topicsChanged: false,
    curated: false,
  }

  try {
    if (opts.dryRun) return await dryRunOne(db, entry, base)

    const ensured = await ensureFeed(db, {
      feedUrl: entry.feedUrl,
      ...(entry.region ? { fetchRegion: entry.region } : {}),
    })
    const titles = { articles: 0, jobs: 0 }
    const fetchOpts = titlesReady ? { onArticleStored: titleEnqueuer(titles) } : {}
    let feedId = ensured.feedId
    let result = await fetchFeed(db, http, feedId, fetchOpts)
    let duplicateOf: number | undefined
    let orphaned = false

    // The curated URL permanently redirects onto a feed we already hold, so this row is an alias
    // of it. fetchFeed says so before storing anything, which is what keeps a rerun honest: the
    // first run renames the feed to its destination, so the next lookup by curated URL misses and
    // lands here. Adopt the feed it duplicates and fetch that instead, so the run still does its
    // job even when the canonical feed has never been fetched.
    if (result.status === 'skipped' && result.duplicateOf !== undefined) {
      duplicateOf = result.duplicateOf
      const [ours] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(articles)
        .where(eq(articles.feedId, feedId))
      // Ours holds nothing anybody could miss, so drop it. One that already accumulated
      // articles is left alone and reported: a member may have read, liked or recommended
      // them, and a seed command has no business deciding that silently.
      if (Number(ours?.n ?? 0) === 0) await db.delete(feeds).where(eq(feeds.id, feedId))
      else orphaned = true
      feedId = duplicateOf
      result = await fetchFeed(db, http, feedId, fetchOpts)
    } else if (result.status === 'fetched' && result.duplicateOf !== undefined) {
      // A member subscribes to the alias, so fetchFeed populated it rather than emptying their
      // blog. Nothing to undo here — just say so, since the list entry is still the wrong URL.
      duplicateOf = result.duplicateOf
      orphaned = true
    }

    // Not ensureFeed's siteId: fetchFeed moves a feed to the site its declared home points at, so
    // that id can be a placeholder. Curating it would feature an empty site and leave the real
    // one private.
    const [feed] = await db.select({ siteId: feeds.siteId }).from(feeds).where(eq(feeds.id, feedId))
    const siteId = feed?.siteId ?? ensured.siteId
    const facts = await siteFacts(db, siteId)
    const report: SeedEntryReport = {
      ...base,
      feedId,
      siteId,
      siteTitle: facts.title,
      primaryLang: facts.primaryLang,
      fetch: result.status,
      newArticles: result.status === 'fetched' ? result.newArticles : 0,
      articles: facts.articles,
      titleJobs: titles.jobs,
      outcome:
        duplicateOf !== undefined
          ? 'unchanged'
          : ensured.created
            ? 'created'
            : result.status === 'fetched'
              ? 'updated'
              : 'unchanged',
      ...(duplicateOf === undefined ? {} : { duplicateOf, reason: 'duplicate' as const, orphaned }),
      ...('kind' in result ? { errorKind: result.kind } : {}),
      ...('error' in result ? { error: result.error } : {}),
      ...('reason' in result ? { error: result.reason } : {}),
    }

    const usable = result.status === 'fetched' || result.status === 'unchanged'
    if (!usable) return { ...report, outcome: 'error', curated: false, reason: 'fetch_failed' }
    if (facts.articles === 0) return { ...report, curated: false, reason: 'no_articles' }

    const curated = await curateSite(db, siteId, {
      listing: 'featured',
      topics: [...entry.topics],
    })
    if (assetsReady && (await siteNeedsAssets(db, siteId))) {
      await createJobSender(db).send(
        QUEUES.siteAssets,
        { siteId },
        { singletonKey: String(siteId) },
      )
    }
    return {
      ...report,
      curated: curated !== null,
      listing: curated?.listing ?? null,
      listingChanged: curated?.listingChanged ?? false,
      topics: curated?.topics ?? [],
      topicsChanged: curated?.topicsChanged ?? false,
      ...(curated?.withheld ? { reason: curated.withheld } : {}),
    }
  } catch (err) {
    return {
      ...base,
      outcome: 'error',
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

/** What a run would do, read from what is already stored. No network, no writes. */
async function dryRunOne(
  db: Db,
  entry: CuratedSite,
  base: SeedEntryReport,
): Promise<SeedEntryReport> {
  const [feed] = await db
    .select({ id: feeds.id, siteId: feeds.siteId })
    .from(feeds)
    .where(eq(feeds.feedUrl, entry.feedUrl))
  if (!feed) return { ...base, outcome: 'skipped', reason: 'dry_run' }
  const facts = await siteFacts(db, feed.siteId)
  // Asking curateSite itself rather than re-deriving its rules: a preview that says it will
  // retopic a claimed site, or relist a rejected one, is worse than no preview.
  const planned = await curateSite(db, feed.siteId, {
    listing: 'featured',
    topics: [...entry.topics],
    dryRun: true,
  })
  return {
    ...base,
    outcome: 'skipped',
    reason: 'dry_run',
    feedId: feed.id,
    siteId: feed.siteId,
    siteTitle: facts.title,
    primaryLang: facts.primaryLang,
    articles: facts.articles,
    listing: planned?.listing ?? facts.listing,
    listingChanged: planned?.listingChanged ?? false,
    topics: planned?.topics ?? facts.topics,
    topicsChanged: planned?.topicsChanged ?? false,
    ...(planned?.withheld ? { withheld: planned.withheld } : {}),
  }
}

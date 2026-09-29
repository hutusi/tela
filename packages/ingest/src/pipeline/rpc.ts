/**
 * What tela-api asks tela-jobs to do on a reader's behalf, because it fetches: discovery, adding a
 * feed by URL, starting a claim. Behind a service binding in production (tela-jobs' `Ingest`
 * entrypoint), so linkedom, the feed parsers and the DNS-pinned client stay out of tela-api's
 * bundle; in-process in tests. Every answer is a plain object: RPC across Workers carries data,
 * not errors.
 */
import { normalizeOrigin } from '@tela/content'
import { feedUrlsFromOpml } from '@tela/content/opml'
import type { TelaDb } from '@tela/data'
import { sql } from 'drizzle-orm'
import { type DiscoveredFeed, discoverFeeds } from '../discover'
import type { HttpClient } from '../http'
import { HttpError } from '../http'
import { registerFeed } from './register'

export type IngestError = 'invalid_url' | 'unreachable' | 'not_a_feed'

export type DiscoverResult = { feeds: DiscoveredFeed[] } | { error: IngestError }
export type AddFeedResult =
  | { feedId: number; siteId: number; created: boolean }
  | { error: IngestError }
export type StartClaimResult = { siteId: number; feedId: number } | { error: IngestError }
export type ReadOpmlResult = { urls: string[] } | { error: 'opml_invalid' }

export interface Ingest {
  /** Feeds for what a member typed: the URL itself, what the page declares, or well-known paths. */
  discover(input: { url: string }): Promise<DiscoverResult>
  /**
   * Register a feed a member chose. A URL Tela already follows is taken as is; a new one is
   * fetched and parsed first, so nothing that is not a feed becomes a feed row.
   */
  addFeed(input: { feedUrl: string; actorId: string | null }): Promise<AddFeedResult>
  /** Find the blog behind a URL a member says is theirs, and file its feed under that home. */
  startClaim(input: { url: string; actorId: string }): Promise<StartClaimResult>
  /** The feed URLs of an OPML document. Parsing only: the feed parsers stay in tela-jobs. */
  readOpml(input: { opml: string }): Promise<ReadOpmlResult>
}

/** What a member typed, as a URL: a bare host gets https. */
export function asUrl(input: string): URL | null {
  const trimmed = input.trim()
  if (!trimmed || trimmed.length > 2048) return null
  try {
    const url = new URL(
      /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed.replace(/^\/+/, '')}`,
    )
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null
  } catch {
    return null
  }
}

export function createIngest(deps: { db: TelaDb; http: HttpClient; now: () => number }): Ingest {
  const { db, http, now } = deps
  const find = async (url: string, maxCandidates: number): Promise<DiscoverResult> => {
    try {
      return { feeds: await discoverFeeds(http, url, { maxCandidates }) }
    } catch (err) {
      if (err instanceof HttpError) return { error: 'unreachable' }
      throw err
    }
  }
  return {
    async discover({ url }) {
      const parsed = asUrl(url)
      if (!parsed) return { error: 'invalid_url' }
      return find(parsed.toString(), 5)
    },

    async addFeed({ feedUrl, actorId }) {
      const parsed = asUrl(feedUrl)
      if (!parsed) return { error: 'invalid_url' }
      // A merged feed's URL is still its URL; it subscribes to the feed it merged into (ADR 0028).
      const known = await db.all<{ id: number; site_id: number }>(sql`
        select coalesce(t.id, f.id) as id, coalesce(t.site_id, f.site_id) as site_id
        from feeds f left join feeds t on t.id = f.merged_into
        where f.feed_url = ${parsed.toString()}
      `)
      const row = known[0]
      if (row) return { feedId: row.id, siteId: row.site_id, created: false }
      const found = await find(parsed.toString(), 1)
      if ('error' in found) return found
      // Normally the URL is the feed itself, picked from discovery. A redirect changes it, and a
      // page URL yields the feed the page declares: either way what is registered was parsed.
      const feed = found.feeds.find((f) => f.url === parsed.toString()) ?? found.feeds[0]
      if (!feed) return { error: 'not_a_feed' }
      return registerFeed(db, { feedUrl: feed.url, homeUrl: feed.homeUrl, actorId, now: now() })
    },

    async startClaim({ url, actorId }) {
      const typed = asUrl(url)
      if (!typed) return { error: 'invalid_url' }
      const found = await find(typed.toString(), 3)
      if ('error' in found) return found
      const feed = found.feeds[0]
      if (!feed) return { error: 'not_a_feed' }
      // The home is the site the member typed, unless they typed the feed's own origin: then the
      // feed's declared home says which site it is.
      const typedOrigin = normalizeOrigin(typed.toString())
      const homeUrl =
        typedOrigin && typedOrigin !== normalizeOrigin(feed.url) ? typedOrigin : feed.homeUrl
      const { feedId, siteId } = await registerFeed(db, {
        feedUrl: feed.url,
        homeUrl,
        actorId,
        now: now(),
      })
      return { siteId, feedId }
    },

    async readOpml({ opml }) {
      try {
        return { urls: feedUrlsFromOpml(opml) }
      } catch {
        return { error: 'opml_invalid' }
      }
    },
  }
}

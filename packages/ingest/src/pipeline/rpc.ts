/**
 * What tela-api asks tela-jobs to do on a reader's behalf, because it fetches: discovery, adding a
 * feed by URL, starting a claim. Behind a service binding in production (tela-jobs' `Ingest`
 * entrypoint), so linkedom, the feed parsers and the DNS-pinned client stay out of tela-api's
 * bundle; in-process in tests. Every answer is a plain object: RPC across Workers carries data,
 * not errors.
 */
import { normalizeOrigin } from '@tela/content'
import { feedsFromOpml } from '@tela/content/opml'
import { feedRoom, type TelaDb } from '@tela/data'
import { sql } from 'drizzle-orm'
import { type DiscoveredFeed, discoverFeeds } from '../discover'
import type { HttpClient } from '../http'
import { HttpError } from '../http'
import { registerFeed } from './register'

/**
 * `feed_too_large`: nothing else was found, and a feed was too large to read (`FEED_MAX_BYTES`).
 * A shell or a tela-api older than it reads it as any error it does not know.
 */
export type IngestError = 'invalid_url' | 'unreachable' | 'not_a_feed' | 'feed_too_large'

export type DiscoverResult = { feeds: DiscoveredFeed[] } | { error: IngestError }
/**
 * `feed_limit`: the feed is new to Tela and the member has added as many today as
 * `member.feedsPerDay` allows (ADR 0063). Only answered to a call that asked for the day to count.
 */
export type FeedLimit = { error: 'feed_limit' }
export type AddFeedResult =
  | { feedId: number; siteId: number; created: boolean }
  | { error: IngestError }
  | FeedLimit
export type StartClaimResult =
  | { siteId: number; feedId: number }
  | { error: IngestError }
  | FeedLimit
/** A folder an OPML document names (ADR 0048), with the feed URLs it lists in it. */
export type OpmlFolder = { name: string; urls: string[] }
/**
 * `folders` is optional because a tela-api reads what an older tela-jobs answers while a deploy
 * is between the two: without it, the feeds are imported as they always were, in no folder.
 */
export type ReadOpmlResult = { urls: string[]; folders?: OpmlFolder[] } | { error: 'opml_invalid' }

export interface Ingest {
  /** Feeds for what a member typed: the URL itself, what the page declares, or well-known paths. */
  discover(input: { url: string }): Promise<DiscoverResult>
  /**
   * Register a feed a member chose. A URL Tela already follows is taken as is; a new one is
   * fetched and parsed first, so nothing that is not a feed becomes a feed row. With `withinDay`,
   * a feed new to Tela counts against the member's day and is refused past it; a tela-api from
   * before ADR 0063 sends none, and nothing is counted.
   */
  addFeed(input: {
    feedUrl: string
    actorId: string | null
    withinDay?: boolean
  }): Promise<AddFeedResult>
  /**
   * Find the blog behind a URL a member says is theirs, and file its feed under that home. A feed
   * new to Tela counts against the member's day with `withinDay`, as `addFeed`'s does.
   */
  startClaim(input: {
    url: string
    actorId: string
    withinDay?: boolean
  }): Promise<StartClaimResult>
  /**
   * The feed URLs of an OPML document, and the folders it lists them in. Parsing only: the feed
   * parsers stay in tela-jobs.
   */
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
  const room = (actorId: string) => sql`${feedRoom(actorId, now())} > 0`
  const find = async (url: string, maxCandidates: number): Promise<DiscoverResult> => {
    try {
      return { feeds: await discoverFeeds(http, url, { maxCandidates }) }
    } catch (err) {
      if (err instanceof HttpError) {
        return { error: err.kind === 'too_large' ? 'feed_too_large' : 'unreachable' }
      }
      throw err
    }
  }
  return {
    async discover({ url }) {
      const parsed = asUrl(url)
      if (!parsed) return { error: 'invalid_url' }
      return find(parsed.toString(), 5)
    },

    async addFeed({ feedUrl, actorId, withinDay }) {
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
      const input = { feedUrl: feed.url, homeUrl: feed.homeUrl, actorId, now: now() }
      if (!withinDay || actorId === null) return registerFeed(db, input)
      // Counted in the statements that write it: a redirect to a feed Tela has is still free.
      const added = await registerFeed(db, { ...input, within: room(actorId) })
      return added ?? { error: 'feed_limit' }
    },

    async startClaim({ url, actorId, withinDay }) {
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
      const input = { feedUrl: feed.url, homeUrl, actorId, now: now() }
      const registered = withinDay
        ? await registerFeed(db, { ...input, within: room(actorId) })
        : await registerFeed(db, input)
      if (!registered) return { error: 'feed_limit' }
      return { siteId: registered.siteId, feedId: registered.feedId }
    },

    async readOpml({ opml }) {
      let feeds: ReturnType<typeof feedsFromOpml>
      try {
        feeds = feedsFromOpml(opml)
      } catch {
        return { error: 'opml_invalid' }
      }
      // By name, in the order the document first names each; matching a name to a folder the
      // member has, case aside, is tela-api's, which can read their folders.
      const folders = new Map<string, string[]>()
      for (const { url, folder } of feeds) {
        if (folder === null) continue
        const urls = folders.get(folder)
        if (urls) urls.push(url)
        else folders.set(folder, [url])
      }
      return {
        urls: feeds.map((f) => f.url),
        folders: [...folders].map(([name, urls]) => ({ name, urls })),
      }
    },
  }
}

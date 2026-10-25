/** Registering a feed the way discovery, the add-feed RPC and the editorial seed do. */
import { normalizeLangTag, normalizeOrigin, type ParsedFeed } from '@tela/content'
import { declaredHomeHonoured, type EnsuredFeed, ensureFeed, type TelaDb } from '@tela/data'
import type { FetchRegion } from '@tela/shared'
import type { SQL } from 'drizzle-orm'

export type RegisterFeedInput = {
  feedUrl: string
  /** The blog's home as discovery saw it, when the parsed feed is not at hand. */
  homeUrl?: string | null
  parsed?: ParsedFeed | null
  /** The member adding the feed: a declared home may file it under a site they claimed. */
  actorId?: string | null
  fetchRegion?: FetchRegion
  /**
   * What a feed new to Tela needs to be created: a member's room for one today (`feedRoom`, ADR
   * 0063). Refused, nothing is written and the answer is null.
   */
  within?: SQL
  now: number
}

/**
 * Find or create the feed and its site. The site is keyed by the declared home when that home is
 * unclaimed or claimed by the acting member, otherwise by the feed's own origin (a placeholder
 * the first fetch may move), so a feed cannot put its posts under another member's site by
 * declaring it.
 */
export async function registerFeed(
  db: TelaDb,
  input: RegisterFeedInput & { within: SQL },
): Promise<EnsuredFeed | null>
export async function registerFeed(db: TelaDb, input: RegisterFeedInput): Promise<EnsuredFeed>
export async function registerFeed(
  db: TelaDb,
  input: RegisterFeedInput,
): Promise<EnsuredFeed | null> {
  const feedOrigin = normalizeOrigin(input.feedUrl)
  if (!feedOrigin) throw new Error(`cannot derive a site origin from ${input.feedUrl}`)
  const parsed = input.parsed ?? null
  const declaredUrl = input.homeUrl ?? parsed?.homeUrl ?? null
  const declared = declaredUrl ? normalizeOrigin(declaredUrl) : null
  const honoured =
    declared !== null &&
    (declared === feedOrigin || (await declaredHomeHonoured(db, declared, input.actorId ?? null)))
  const siteOrigin = honoured && declared ? declared : feedOrigin
  const feed = {
    feedUrl: input.feedUrl,
    host: new URL(input.feedUrl).hostname.toLowerCase(),
    siteOrigin,
    title: parsed?.title ?? null,
    description: parsed?.description ?? null,
    format: parsed?.format ?? null,
    hubUrl: parsed?.hubUrl ?? null,
    addedBy: input.actorId ?? null,
    fetchRegion: input.fetchRegion ?? 'global',
    site: {
      title: parsed?.title ?? null,
      description: parsed?.description ?? null,
      primaryLang: normalizeLangTag(parsed?.language ?? null),
    },
    now: input.now,
  }
  return input.within ? ensureFeed(db, { ...feed, within: input.within }) : ensureFeed(db, feed)
}

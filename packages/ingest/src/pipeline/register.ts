/** Registering a feed the way discovery, the add-feed RPC and the editorial seed do. */
import { normalizeLangTag, type ParsedFeed } from '@tela/content'
import { declaredHomeHonoured, type EnsuredFeed, ensureFeed, type TelaDb } from '@tela/data'
import { type BlogRules, type FetchRegion, siteKeyOf } from '@tela/shared'
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
  /** Which blogs are by path (ADR 0069); unset is `BLOG_RULES`. */
  rules?: BlogRules | undefined
  now: number
}

/**
 * Find or create the feed and its site. The site is keyed by the declared home when that home is
 * unclaimed or claimed by the acting member, otherwise by the feed's own address (a placeholder
 * the first fetch may move), so a feed cannot put its posts under another member's site by
 * declaring it. Either is a site key: an origin, or a path on a shared host or in a named
 * section (ADR 0069).
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
  const own = siteKeyOf(input.feedUrl, input.rules)
  if (!own) throw new Error(`cannot derive a site key from ${input.feedUrl}`)
  const parsed = input.parsed ?? null
  const declaredUrl = input.homeUrl ?? parsed?.homeUrl ?? null
  const declared = declaredUrl ? siteKeyOf(declaredUrl, input.rules) : null
  const honoured =
    declared !== null &&
    (declared === own || (await declaredHomeHonoured(db, declared, input.actorId ?? null)))
  const siteHome = honoured && declared ? declared : own
  const feed = {
    feedUrl: input.feedUrl,
    host: new URL(input.feedUrl).hostname.toLowerCase(),
    siteHome,
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

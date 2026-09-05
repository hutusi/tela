import { normalizeLangTag, normalizeOrigin, type ParsedFeed } from '@tela/content'
import { type Db, feeds, sites } from '@tela/db'
import { eq, sql } from 'drizzle-orm'

export type EnsureSiteInput = {
  homeUrl: string | null
  feedUrl: string
  title?: string | null
  description?: string | null
  language?: string | null
  /** Member adding the feed; a declared home may join a site this member claimed. */
  actorId?: string | null
}

/** Whether the site is keyed by the declared home or by the feed's own origin. */
export type SiteHome = 'declared' | 'placeholder'

export type EnsureSiteResult = { siteId: number; siteHome: SiteHome }

/**
 * Find or create the site a feed belongs to, keyed by its normalized origin: the declared home
 * when there is one, otherwise the feed's own origin (a placeholder the first fetch may move).
 * A declared home is only honoured when the site for it is unclaimed or claimed by the acting
 * member, so a feed cannot put its posts under another member's site just by declaring that
 * site as its home.
 */
export async function ensureSite(db: Db, input: EnsureSiteInput): Promise<EnsureSiteResult> {
  const feedOrigin = normalizeOrigin(input.feedUrl)
  if (!feedOrigin) throw new Error(`cannot derive a site origin from ${input.feedUrl}`)
  const declared = input.homeUrl ? normalizeOrigin(input.homeUrl) : null
  let origin = feedOrigin
  let siteHome: SiteHome = 'placeholder'
  if (declared) {
    const [existing] = await db
      .select({ claimedBy: sites.claimedBy })
      .from(sites)
      .where(eq(sites.homeUrl, declared))
    const claimedByOther =
      existing !== undefined &&
      existing.claimedBy !== null &&
      existing.claimedBy !== (input.actorId ?? null)
    if (declared === feedOrigin || !claimedByOther) {
      origin = declared
      siteHome = 'declared'
    }
  }
  const [row] = await db
    .insert(sites)
    .values({
      homeUrl: origin,
      title: input.title ?? null,
      description: input.description ?? null,
      primaryLang: normalizeLangTag(input.language),
    })
    .onConflictDoUpdate({
      target: sites.homeUrl,
      set: {
        title: sql`coalesce(${sites.title}, excluded.title)`,
        description: sql`coalesce(${sites.description}, excluded.description)`,
        primaryLang: sql`coalesce(${sites.primaryLang}, excluded.primary_lang)`,
      },
    })
    .returning({ id: sites.id })
  return { siteId: (row as { id: number }).id, siteHome }
}

export type EnsureFeedInput = {
  feedUrl: string
  parsed?: ParsedFeed | null
  /** The blog's home as discovery saw it, when the parsed feed is not at hand. */
  homeUrl?: string | null
  /** Member adding the feed (see ensureSite). */
  actorId?: string | null
  /** Force the region (e.g. a known mainland-China host). */
  fetchRegion?: 'global' | 'cn'
}

export type EnsureFeedResult = {
  feedId: number
  siteId: number
  created: boolean
  /** Set when the feed was created here. */
  siteHome?: SiteHome
}

/** Find or create a feed row (and its site). New feeds are due immediately. */
export async function ensureFeed(db: Db, input: EnsureFeedInput): Promise<EnsureFeedResult> {
  const [existing] = await db
    .select({ id: feeds.id, siteId: feeds.siteId })
    .from(feeds)
    .where(eq(feeds.feedUrl, input.feedUrl))
  if (existing) return { feedId: existing.id, siteId: existing.siteId, created: false }

  const parsed = input.parsed ?? null
  const { siteId, siteHome } = await ensureSite(db, {
    homeUrl: input.homeUrl ?? parsed?.homeUrl ?? null,
    feedUrl: input.feedUrl,
    title: parsed?.title ?? null,
    description: parsed?.description ?? null,
    language: parsed?.language ?? null,
    actorId: input.actorId ?? null,
  })
  const [row] = await db
    .insert(feeds)
    .values({
      siteId,
      feedUrl: input.feedUrl,
      format: parsed?.format ?? null,
      title: parsed?.title ?? null,
      description: parsed?.description ?? null,
      hubUrl: parsed?.hubUrl ?? null,
      addedBy: input.actorId ?? null,
      fetchRegion: input.fetchRegion ?? 'global',
      nextFetchAt: new Date(),
    })
    .onConflictDoNothing({ target: feeds.feedUrl })
    .returning({ id: feeds.id, siteId: feeds.siteId })
  if (row) return { feedId: row.id, siteId: row.siteId, created: true, siteHome }
  const [raced] = await db
    .select({ id: feeds.id, siteId: feeds.siteId })
    .from(feeds)
    .where(eq(feeds.feedUrl, input.feedUrl))
  if (!raced) throw new Error(`feed ${input.feedUrl} vanished during insert`)
  return { feedId: raced.id, siteId: raced.siteId, created: false }
}

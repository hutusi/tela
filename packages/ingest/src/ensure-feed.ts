import { normalizeLangTag, normalizeOrigin, type ParsedFeed } from '@tela/content'
import { type Db, feeds, sites } from '@tela/db'
import { eq, sql } from 'drizzle-orm'

export type EnsureSiteInput = {
  homeUrl: string | null
  feedUrl: string
  title?: string | null
  description?: string | null
  language?: string | null
}

/** Find or create the site a feed belongs to, keyed by its normalized origin. */
export async function ensureSite(db: Db, input: EnsureSiteInput): Promise<{ siteId: number }> {
  const origin = normalizeOrigin(input.homeUrl ?? input.feedUrl) ?? normalizeOrigin(input.feedUrl)
  if (!origin) throw new Error(`cannot derive a site origin from ${input.feedUrl}`)
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
  return { siteId: (row as { id: number }).id }
}

export type EnsureFeedInput = {
  feedUrl: string
  parsed?: ParsedFeed | null
  /** The blog's home as discovery saw it, when the parsed feed is not at hand. */
  homeUrl?: string | null
  /** Force the region (e.g. a known mainland-China host). */
  fetchRegion?: 'global' | 'cn'
}

export type EnsureFeedResult = { feedId: number; siteId: number; created: boolean }

/** Find or create a feed row (and its site). New feeds are due immediately. */
export async function ensureFeed(db: Db, input: EnsureFeedInput): Promise<EnsureFeedResult> {
  const [existing] = await db
    .select({ id: feeds.id, siteId: feeds.siteId })
    .from(feeds)
    .where(eq(feeds.feedUrl, input.feedUrl))
  if (existing) return { feedId: existing.id, siteId: existing.siteId, created: false }

  const parsed = input.parsed ?? null
  const { siteId } = await ensureSite(db, {
    homeUrl: input.homeUrl ?? parsed?.homeUrl ?? null,
    feedUrl: input.feedUrl,
    title: parsed?.title ?? null,
    description: parsed?.description ?? null,
    language: parsed?.language ?? null,
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
      fetchRegion: input.fetchRegion ?? 'global',
      nextFetchAt: new Date(),
    })
    .onConflictDoNothing({ target: feeds.feedUrl })
    .returning({ id: feeds.id, siteId: feeds.siteId })
  if (row) return { feedId: row.id, siteId: row.siteId, created: true }
  const [raced] = await db
    .select({ id: feeds.id, siteId: feeds.siteId })
    .from(feeds)
    .where(eq(feeds.feedUrl, input.feedUrl))
  if (!raced) throw new Error(`feed ${input.feedUrl} vanished during insert`)
  return { feedId: raced.id, siteId: raced.siteId, created: false }
}

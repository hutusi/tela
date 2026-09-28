/**
 * Sites and feeds as the ingest pipeline and the API create and move them. Statements address
 * sites by origin (`home_url`) rather than by an id read earlier, so a move stays correct even if
 * another feed's fetch created that site a moment ago.
 */
import { COMMUNITY_LISTING_MIN_READERS, type FetchRegion } from '@tela/shared'
import { eq, type SQL, sql } from 'drizzle-orm'
import type { TelaDb } from '../db'
import { feeds, sites } from '../schema'
import { bumpSeq, currentSeq } from '../seq'

export type SiteMeta = {
  title?: string | null
  description?: string | null
  primaryLang?: string | null
}

/** Insert the site for `origin` unless it exists; fill metadata it lacks. */
export function ensureOriginSite(db: TelaDb, origin: string, now: number, meta: SiteMeta = {}) {
  return db
    .insert(sites)
    .values({
      homeUrl: origin,
      title: meta.title ?? null,
      description: meta.description ?? null,
      primaryLang: meta.primaryLang ?? null,
      createdAt: now,
      updatedAt: now,
      seq: currentSeq,
    })
    .onConflictDoUpdate({
      target: sites.homeUrl,
      set: {
        title: sql`coalesce(${sites.title}, excluded.title)`,
        description: sql`coalesce(${sites.description}, excluded.description)`,
        primaryLang: sql`coalesce(${sites.primaryLang}, excluded.primary_lang)`,
      },
    })
}

const siteIdOf = (origin: string) => sql`(select id from sites where home_url = ${origin})`

/**
 * Recount distinct readers of each site, then open the community door into Discover (ADR 0018):
 * an unclaimed private site with enough readers is listed. One-way, and never touching an
 * editorial pick or a site an operator rejected.
 */
export function recountReaders(db: TelaDb, siteIds: SQL, now: number) {
  return [
    db.run(sql`
      update sites set
        reader_count = (
          select count(distinct s.user_id) from subscriptions s
          join feeds f on f.id = s.feed_id
          where f.site_id = sites.id and s.deleted_at is null
        ),
        updated_at = ${now}, seq = ${currentSeq}
      where id in (${siteIds})
    `),
    db.run(sql`
      update sites set listing = 'listed', seq = ${currentSeq}
      where id in (${siteIds}) and listing = 'private' and claimed_by is null
        and reader_count >= ${COMMUNITY_LISTING_MIN_READERS}
    `),
  ] as const
}

/**
 * Re-point a feed to the site for `origin` (creating it), drop the site it left if that was an
 * empty unclaimed placeholder, and recount both. Statements for a batch that has already bumped
 * the sync sequence.
 */
export function moveFeedToOrigin(
  db: TelaDb,
  feed: { id: number; siteId: number },
  origin: string,
  now: number,
) {
  return [
    ensureOriginSite(db, origin, now),
    db.run(
      sql`update feeds set site_id = ${siteIdOf(origin)}, updated_at = ${now}, seq = ${currentSeq} where id = ${feed.id}`,
    ),
    ...recountReaders(db, sql`${feed.siteId}, ${siteIdOf(origin)}`, now),
    db.run(sql`
      delete from sites where id = ${feed.siteId} and id <> ${siteIdOf(origin)}
        and claimed_by is null and not exists (select 1 from feeds where site_id = ${feed.siteId})
    `),
  ] as const
}

export type EnsureFeedInput = {
  feedUrl: string
  host: string
  /** The site origin to file the feed under: its declared home when honoured, else its own. */
  siteOrigin: string
  title?: string | null
  description?: string | null
  format?: 'rss' | 'atom' | 'rdf' | 'json' | null
  hubUrl?: string | null
  addedBy?: string | null
  fetchRegion?: FetchRegion
  /** What the parsed feed says about its site, for a site created here. */
  site?: SiteMeta
  now: number
}

/** Find or create a feed (and its site). A new feed is due immediately. */
export async function ensureFeed(
  db: TelaDb,
  input: EnsureFeedInput,
): Promise<{ feedId: number; siteId: number; created: boolean }> {
  const [, , inserted] = await db.batch([
    bumpSeq(db),
    ensureOriginSite(db, input.siteOrigin, input.now, input.site ?? {}),
    db
      .insert(feeds)
      .values({
        siteId: sql`${siteIdOf(input.siteOrigin)}`,
        feedUrl: input.feedUrl,
        host: input.host,
        title: input.title ?? null,
        description: input.description ?? null,
        format: input.format ?? null,
        hubUrl: input.hubUrl ?? null,
        addedBy: input.addedBy ?? null,
        fetchRegion: input.fetchRegion ?? 'global',
        nextFetchAt: input.now,
        createdAt: input.now,
        updatedAt: input.now,
        seq: currentSeq,
      })
      .onConflictDoNothing({ target: feeds.feedUrl })
      .returning({ id: feeds.id, siteId: feeds.siteId }),
  ])
  const row = inserted[0]
  if (row) return { feedId: row.id, siteId: row.siteId, created: true }
  const existing = await db
    .select({ id: feeds.id, siteId: feeds.siteId })
    .from(feeds)
    .where(eq(feeds.feedUrl, input.feedUrl))
  const found = existing[0]
  if (!found) throw new Error(`feed ${input.feedUrl} vanished during insert`)
  return { feedId: found.id, siteId: found.siteId, created: false }
}

/** Where a declared home may file a feed: an unclaimed site, or one the acting member claimed. */
export async function declaredHomeHonoured(
  db: TelaDb,
  declaredOrigin: string,
  actorId: string | null,
): Promise<boolean> {
  const rows = await db
    .select({ claimedBy: sites.claimedBy })
    .from(sites)
    .where(eq(sites.homeUrl, declaredOrigin))
  const claimedBy = rows[0]?.claimedBy ?? null
  return claimedBy === null || claimedBy === actorId
}

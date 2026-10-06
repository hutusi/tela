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
 * A blog waiting for an operator's review for Discover (ADR 0041), over `sites s`: one a member
 * added (private, unclaimed, someone reads it), with a live feed that has brought posts, which no
 * operator has decided about yet (`review` is null; every decision writes it with `reviewed_at`).
 * A placeholder no fetch has filled, a blog whose feeds died or merged away, and one nobody reads
 * any more wait for nothing. The console's queue and the Monday digest both count it.
 */
export const DISCOVER_REVIEW = sql`(s.listing = 'private' and s.claimed_by is null
  and s.review is null and s.reader_count > 0
  and exists (select 1 from feeds f join articles a on a.feed_id = f.id
    where f.site_id = s.id and f.merged_into is null and f.status = 'active'))`

/**
 * A blog's reader count as a public answer may give it, over the sites table aliased `alias`:
 * the count from the community door's three readers up, null below (ADR 0041). An operator may
 * list a blog one member reads, and a public "1 reader" would name that member's reading by
 * elimination; null reads like an editorial pick's nobody yet. Order by `coalesce(…, 0)`, never
 * by `reader_count`, or the order alone tells 0 from 1 from 2.
 */
export const publicReaderCount = (alias: string): SQL =>
  sql.raw(`(case when ${alias}.reader_count >= ${COMMUNITY_LISTING_MIN_READERS}
    then ${alias}.reader_count end)`)

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

/**
 * Register many feed URLs at once (an OPML import): each under a placeholder site keyed by its own
 * origin, due at once. Three statements whatever the count, so 500 feeds stay far inside D1's
 * per-invocation query limit; the first fetch moves each feed to the site it declares. Returns
 * the feed ids, new and existing alike. Nothing is fetched here, so nothing is verified: a URL
 * that is not a feed fails its first fetch and dies like any other dead feed.
 */
export async function importFeedUrls(
  db: TelaDb,
  feeds: { feedUrl: string; host: string; origin: string }[],
  actorId: string,
  now: number,
): Promise<number[]> {
  if (feeds.length === 0) return []
  const rows = JSON.stringify(feeds.map((f) => [f.feedUrl, f.host, f.origin]))
  const results = await db.batch([
    bumpSeq(db),
    db.run(sql`
      insert into sites (home_url, created_at, updated_at, seq)
      select distinct value->>2, ${now}, ${now}, ${currentSeq} from json_each(${rows}) where true
      on conflict (home_url) do nothing
    `),
    db.run(sql`
      insert into feeds (site_id, feed_url, host, next_fetch_at, added_by, created_at, updated_at, seq)
      select s.id, value->>0, value->>1, ${now}, ${actorId}, ${now}, ${now}, ${currentSeq}
      from json_each(${rows}) join sites s on s.home_url = value->>2
      where true
      on conflict (feed_url) do nothing
    `),
    // A merged feed's URL subscribes to the feed it merged into (ADR 0028).
    db.all(sql`
      select distinct coalesce(f.merged_into, f.id) as id from feeds f
      where f.feed_url in (select value->>0 from json_each(${rows}))
    `),
  ] as never)
  return ((results as unknown[])[3] as { id: number }[]).map((r) => r.id)
}

/** Claims a member asked to verify. Leased by the site's host, so one claim per site at a time. */
export const dueClaims = (): SQL =>
  sql`select c.id as key, substr(s.home_url, instr(s.home_url, '://') + 3) as host,
        c.created_at as ord
      from site_claims c join sites s on s.id = c.site_id where c.status = 'pending'`

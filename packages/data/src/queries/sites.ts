/**
 * Sites and feeds as the ingest pipeline and the API create and move them. Statements address
 * sites by their key (`home_url`: the blog's origin, or for a blog by path that origin and its
 * path, `siteKeyOf` in @tela/shared, ADR 0069) rather than by an id read earlier, so a move stays
 * correct even if another feed's fetch created that site a moment ago.
 */
import { COMMUNITY_LISTING_MIN_READERS, type FetchRegion } from '@tela/shared'
import { eq, type SQL, sql } from 'drizzle-orm'
import type { TelaDb } from '../db'
import { first } from '../first'
import { feeds, sites } from '../schema'
import { bumpSeq, currentSeq } from '../seq'

type BatchItem = Parameters<TelaDb['batch']>[0][number]

export type SiteMeta = {
  title?: string | null
  description?: string | null
  primaryLang?: string | null
}

const siteIdOf = (home: string) => sql`(select id from sites where home_url = ${home})`

/** The host of a site's key (`https://world.hey.com/dhh` → `world.hey.com`), in SQL, for leases. */
export const siteHost = (homeUrl: SQL) =>
  sql`substr(substr(${homeUrl}, instr(${homeUrl}, '://') + 3), 1,
    instr(substr(${homeUrl}, instr(${homeUrl}, '://') + 3) || '/', '/') - 1)`

/**
 * `ensureHomeSite` for a feed about to be inserted, and nothing when that feed exists already:
 * it keeps the site it has, so a site made for it here would hold no feed and show in Discover as
 * a card with no name and no posts. In the batch that inserts the feed, so the two agree.
 */
function ensureSiteForNewFeed(
  db: TelaDb,
  feedUrl: string,
  home: string,
  now: number,
  meta: SiteMeta,
  within: SQL,
) {
  return db.run(sql`
    insert into sites (home_url, title, description, primary_lang, created_at, updated_at, seq)
    select ${home}, ${meta.title ?? null}, ${meta.description ?? null}, ${meta.primaryLang ?? null},
      ${now}, ${now}, ${currentSeq}
    where not exists (select 1 from feeds where feed_url = ${feedUrl}) and ${within}
    on conflict (home_url) do update set
      title = coalesce(sites.title, excluded.title),
      description = coalesce(sites.description, excluded.description),
      primary_lang = coalesce(sites.primary_lang, excluded.primary_lang)
  `)
}

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
 * The order of a blog's feeds, over `feeds` aliased `alias`, its main feed first (ADR 0068): one
 * still fetched (an operator's pause and a dead feed are not), then the one with the most posts,
 * then the oldest. What Subscribe adds from a blog's card, its page and Discover's OPML, and the
 * order Add offers a listed blog's feeds in, so the two never name different feeds.
 */
export const mainFeedOrder = (alias: string): SQL =>
  sql.raw(`(${alias}.status = 'active') desc,
    (select count(*) from articles mp where mp.feed_id = ${alias}.id) desc, ${alias}.id`)

/**
 * A blog's reader count as a member's device holds it, over the sites table aliased `alias`: the
 * count from three readers up, 0 below (ADR 0041). Below three, "2 readers on Tela" would tell a
 * subscriber that one other member reads the blog; the row's type is a number, so 0, not null.
 */
export const deviceReaderCount = (alias: string): SQL =>
  sql.raw(`(case when ${alias}.reader_count >= ${COMMUNITY_LISTING_MIN_READERS}
    then ${alias}.reader_count else 0 end)`)

/**
 * Recount distinct readers of each site, then open the community door into Discover (ADR 0018):
 * an unclaimed private site with enough readers is listed. One-way, and never touching an
 * editorial pick or a site an operator rejected. The row is stamped with the batch's seq only
 * when what a device holds of it changed (`deviceReaderCount`, or the listing): a subscribe
 * that takes a blog from one reader to two changes nothing a device holds, and re-sending the
 * row to its other readers would tell them, by its arrival, that someone came or went.
 */
export function recountReaders(db: TelaDb, siteIds: SQL, now: number) {
  const count = sql`(
    select count(distinct s.user_id) from subscriptions s
    join feeds f on f.id = s.feed_id
    where f.site_id = sites.id and s.deleted_at is null
  )`
  const min = COMMUNITY_LISTING_MIN_READERS
  return [
    db.run(sql`
      update sites set
        seq = case when ${count} <> reader_count and (${count} >= ${min} or reader_count >= ${min})
          then ${currentSeq} else seq end,
        reader_count = ${count},
        updated_at = ${now}
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
 * Rows one re-stamping batch gives one seq: under a pull's page (`PAGE_ROWS`, 1000), so a pull can
 * always end a page after them. One seq for a whole blog's rows would be a group no page can end
 * inside, and `readPull` would send everything after the cursor unpaged.
 */
export const RESTAMP_CHUNK = 900

/**
 * Translation was turned back on for `siteIds` (ADR 0065): stamp the blogs' title and body
 * translation rows again, so an app's sync, which left them out while the blogs said no, sends
 * them now. The web's devices held them all along and take them again unchanged. Body
 * translations follow each post's current content, as the pull's do. How many rows it stamped.
 *
 * Run once the batch that turned translation on has committed, in batches of its own:
 * `RESTAMP_CHUNK` rows of one table each, each batch with its own `bumpSeq`, so no seq holds more
 * than a page. The rows to stamp are those at or below the sequence as it stands when this
 * starts; one stamped, or written since, is above it and sent anyway. An app that pulls between
 * the switch and the last chunk is sent each chunk in a later delta, since the switch is already
 * read at every pull. Stamping a blog that never said no only sends its rows again.
 */
export async function restampTranslations(db: TelaDb, siteIds: readonly number[]): Promise<number> {
  if (siteIds.length === 0) return 0
  const feedsOf = sql`select id from feeds
    where site_id in (select value from json_each(${JSON.stringify([...new Set(siteIds)])}))`
  const [head] = await db.all<{ seq: number }>(
    sql`select coalesce((select v from counters where k = 'seq'), 0) as seq`,
  )
  const upTo = Number(head?.seq ?? 0)
  const chunk = sql.raw(String(RESTAMP_CHUNK))
  const chunks = [
    sql`update article_titles set seq = ${currentSeq}
      where rowid in (select rowid from article_titles
        where feed_id in (${feedsOf}) and seq <= ${upTo} limit ${chunk})
      returning 1 as stamped`,
    sql`update body_translations set seq = ${currentSeq}
      where rowid in (select rowid from body_translations
        where content_key in (select content_key from articles
          where feed_id in (${feedsOf}) and content_key is not null)
          and seq <= ${upTo} limit ${chunk})
      returning 1 as stamped`,
  ]
  let stamped = 0
  for (const statement of chunks) {
    for (;;) {
      const [, rows] = (await db.batch([bumpSeq(db), db.all(statement)] as never)) as unknown as [
        unknown,
        unknown[],
      ]
      stamped += rows.length
      if (rows.length < RESTAMP_CHUNK) break
    }
  }
  return stamped
}

/**
 * Re-point a feed to the site keyed `home` (creating it), drop the site it left if that was an
 * empty unclaimed placeholder, and recount both; moved off a blog that said no to translation onto
 * one that allows it, stamp its translations again. A site made here takes its name, description
 * and language from the feed and its posts at once. Statements for a batch that has already
 * bumped the sync sequence.
 */
export function moveFeedToHome(
  db: TelaDb,
  feed: { id: number; siteId: number },
  home: string,
  now: number,
  /**
   * Whether a site made here keeps every no the one the feed left had said (Hide, feed only, no
   * translation): when the feed was that blog's and only its key changed (`fileFeedUnder`). A
   * feed detached from a claimed blog was never the owner's, and takes none of their decisions.
   */
  keepNos = false,
) {
  // Moved from a blog that said no to translation onto one that allows it, the feed's titles and
  // body translations are shown to apps from now on, and stamped again so a delta carries them
  // (ADR 0065): their seq is from when they were left out. Asked before the feed moves, of the
  // blog it is on as this batch runs. One feed's rows, in this batch, unlike a blog's switch
  // (`restampTranslations`): a move is atomic with them, and a feed's rows in one language are
  // what its own fetches have written, at most its archive.
  const backOn = sql`exists (select 1 from feeds f join sites s on s.id = f.site_id
      where f.id = ${feed.id} and s.translation_opt_out = 1)
    and exists (select 1 from sites where id = ${siteIdOf(home)} and translation_opt_out = 0)`
  // Each no is a decision about these posts, so a blog split off the one that said it keeps it
  // until someone decides again: a split must not list what an operator hid, nor fetch the pages
  // of a blog that asked for its feed alone (ADR 0069). A yes is never kept: the new blog waits
  // in the review queue like any other.
  const keep = keepNos ? sql`true` : sql`false`
  return [
    db.run(sql`
      insert into sites (home_url, listing, review, reviewed_at, translation_opt_out, feed_only,
        created_at, updated_at, seq)
      select ${home}, case when ${keep} and listing = 'rejected' then 'rejected' else 'private' end,
        case when ${keep} and listing = 'rejected' then review end,
        case when ${keep} and listing = 'rejected' then reviewed_at end,
        ${keep} and translation_opt_out, ${keep} and feed_only, ${now}, ${now}, ${currentSeq}
      from sites where id = ${feed.siteId}
      on conflict (home_url) do nothing
    `),
    db.run(
      sql`update article_titles set seq = ${currentSeq} where feed_id = ${feed.id} and ${backOn}`,
    ),
    db.run(sql`
      update body_translations set seq = ${currentSeq}
      where content_key in (select content_key from articles
        where feed_id = ${feed.id} and content_key is not null)
        and ${backOn}
    `),
    db.run(
      sql`update feeds set site_id = ${siteIdOf(home)}, updated_at = ${now}, seq = ${currentSeq} where id = ${feed.id}`,
    ),
    // A fetch fills what a site lacks only when the feed's body changes, so a site this made from
    // a feed already fetched would have no language (and so no place in a language's Discover)
    // until the blog next posts. Both sites' languages follow the posts they now hold.
    db.run(sql`
      update sites set
        title = case when id = ${siteIdOf(home)}
          then coalesce(title, (select title from feeds where id = ${feed.id})) else title end,
        description = case when id = ${siteIdOf(home)}
          then coalesce(description, (select description from feeds where id = ${feed.id}))
          else description end,
        primary_lang = coalesce((
          select a.source_lang from articles a join feeds f on f.id = a.feed_id
          where f.site_id = sites.id and a.source_lang is not null
          group by a.source_lang order by count(*) desc, a.source_lang limit 1
        ), primary_lang),
        updated_at = ${now}, seq = ${currentSeq}
      where id in (${feed.siteId}, ${siteIdOf(home)})
    `),
    ...recountReaders(db, sql`${feed.siteId}, ${siteIdOf(home)}`, now),
    db.run(sql`
      delete from sites where id = ${feed.siteId} and id <> ${siteIdOf(home)}
        and claimed_by is null and not exists (select 1 from feeds where site_id = ${feed.siteId})
    `),
  ] as const
}

export type EnsureFeedInput = {
  feedUrl: string
  host: string
  /** The site key to file the feed under: its declared home's when honoured, else its own. */
  siteHome: string
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

export type EnsuredFeed = { feedId: number; siteId: number; created: boolean }

/**
 * Find or create a feed (and its site). A new feed is due immediately. With `within`, a feed new to
 * Tela is created only while that holds, as a member's room for new feeds (`feedRoom`, ADR 0063):
 * evaluated in the statements that write, so two adds cannot both take the day's last place, and
 * null when it refused one. A feed Tela has is found whatever it says.
 */
export async function ensureFeed(
  db: TelaDb,
  input: EnsureFeedInput & { within: SQL },
): Promise<EnsuredFeed | null>
export async function ensureFeed(db: TelaDb, input: EnsureFeedInput): Promise<EnsuredFeed>
export async function ensureFeed(
  db: TelaDb,
  input: EnsureFeedInput & { within?: SQL },
): Promise<EnsuredFeed | null> {
  const within = input.within ?? sql`true`
  const [, , inserted] = (await db.batch([
    bumpSeq(db),
    ensureSiteForNewFeed(db, input.feedUrl, input.siteHome, input.now, input.site ?? {}, within),
    // A feed that exists already made no site above; its own site keeps the column filled until
    // the conflict below drops the row.
    db.all(sql`
      insert into feeds (site_id, feed_url, host, title, description, format, hub_url, added_by,
        fetch_region, next_fetch_at, created_at, updated_at, seq)
      select coalesce(${siteIdOf(input.siteHome)},
          (select site_id from feeds where feed_url = ${input.feedUrl})),
        ${input.feedUrl}, ${input.host}, ${input.title ?? null}, ${input.description ?? null},
        ${input.format ?? null}, ${input.hubUrl ?? null}, ${input.addedBy ?? null},
        ${input.fetchRegion ?? 'global'}, ${input.now}, ${input.now}, ${input.now}, ${currentSeq}
      where ${within}
      on conflict (feed_url) do nothing
      returning id, site_id
    `),
  ] as never)) as unknown as [unknown, unknown, { id: number; site_id: number }[]]
  const row = inserted[0]
  if (row) return { feedId: Number(row.id), siteId: Number(row.site_id), created: true }
  const existing = await db
    .select({ id: feeds.id, siteId: feeds.siteId })
    .from(feeds)
    .where(eq(feeds.feedUrl, input.feedUrl))
  const found = existing[0]
  if (found) return { feedId: found.id, siteId: found.siteId, created: false }
  if (input.within) return null
  throw new Error(`feed ${input.feedUrl} vanished during insert`)
}

/** Where a declared home may file a feed: an unclaimed site, or one the acting member claimed. */
export async function declaredHomeHonoured(
  db: TelaDb,
  declaredHome: string,
  actorId: string | null,
): Promise<boolean> {
  const rows = await db
    .select({ claimedBy: sites.claimedBy })
    .from(sites)
    .where(eq(sites.homeUrl, declaredHome))
  const claimedBy = rows[0]?.claimedBy ?? null
  return claimedBy === null || claimedBy === actorId
}

/** What filing a feed under another home did (`fileFeedUnder`). */
export type FiledOutcome = 'kept' | 'renamed' | 'joined' | 'split' | 'blocked'

/**
 * Statements that file a feed under the site keyed `home`: rename its site when it is that site's
 * only feed and no site has the home yet, otherwise join the site there or split onto a new one.
 * Nothing moves off a claimed site or onto one: a claim settles which feeds are the blog's
 * (ADR 0011), and nothing joins a site that has not said a no the one it leaves had said (Hide,
 * feed only, no translation): a split keeps them (`moveFeedToHome`), but a site that exists is
 * another blog's decision, and copying the no onto it would reach posts it never covered. For a
 * batch that has already bumped the sync sequence. That batch aborts, as a lost lease's fence
 * does (`isFenceRefusal`), when what this decided on has changed by the time it runs: a claim
 * verified on either site, a no said, the feed moved, or for a rename another feed or site.
 */
export async function fileFeedUnder(
  db: TelaDb,
  feed: { id: number; siteId: number },
  site: { homeUrl: string; claimedBy: string | null },
  home: string,
  now: number,
): Promise<{ statements: BatchItem[]; outcome: FiledOutcome }> {
  if (home === site.homeUrl) return { statements: [], outcome: 'kept' }
  if (site.claimedBy !== null) return { statements: [], outcome: 'blocked' }
  const loosens = sql`exists (select 1 from sites s join sites t on t.home_url = ${home}
    where s.id = ${feed.siteId} and ((s.listing = 'rejected' and t.listing <> 'rejected')
      or (s.feed_only = 1 and t.feed_only = 0)
      or (s.translation_opt_out = 1 and t.translation_opt_out = 0)))`
  const target = await first<{ id: number; claimed_by: string | null; loosens: number }>(
    db,
    sql`select id, claimed_by, ${loosens} as loosens from sites where home_url = ${home}`,
  )
  if (target?.claimed_by || target?.loosens) return { statements: [], outcome: 'blocked' }
  const siblings = await first<{ n: number }>(
    db,
    sql`select count(*) as n from feeds where site_id = ${feed.siteId} and id <> ${feed.id}`,
  )
  // Read above, and decided on: a caller that holds no lease on these sites (curate) can find a
  // claim verified, or the blog changed, between the reads and its batch.
  const changed = sql`not exists (select 1 from feeds where id = ${feed.id} and site_id = ${feed.siteId})
    or exists (select 1 from sites where (id = ${feed.siteId} or home_url = ${home})
      and claimed_by is not null)
    or ${loosens}`
  if (!target && (siblings?.n ?? 0) === 0) {
    const notAlone = sql`exists (select 1 from sites where home_url = ${home})
      or exists (select 1 from feeds where site_id = ${feed.siteId} and id <> ${feed.id})`
    return {
      statements: [
        db.run(sql`insert into lease_fence (x) select null where ${changed} or ${notAlone}`),
        db.run(sql`
          update sites set home_url = ${home}, updated_at = ${now}, seq = ${currentSeq}
          where id = ${feed.siteId}
        `),
      ],
      outcome: 'renamed',
    }
  }
  return {
    statements: [
      db.run(sql`insert into lease_fence (x) select null where ${changed}`),
      ...moveFeedToHome(db, feed, home, now, true),
    ],
    outcome: target ? 'joined' : 'split',
  }
}

/**
 * Register many feed URLs at once (an OPML import): each new one under a placeholder site keyed by
 * its own origin, due at once. Three statements whatever the count, so 500 feeds stay far inside
 * D1's per-invocation query limit; the first fetch moves each feed to the site it declares. A URL
 * Tela has already keeps its feed's site, and gets no placeholder: nothing would ever fill it.
 * Returns the feed ids, new and existing alike. Nothing is fetched here, so nothing is verified:
 * a URL that is not a feed fails its first fetch and dies like any other dead feed.
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
      select distinct value->>2, ${now}, ${now}, ${currentSeq} from json_each(${rows})
      where not exists (select 1 from feeds f where f.feed_url = value->>0)
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

/** Claims a member asked to verify. Leased by the site's host, so one claim per host at a time. */
export const dueClaims = (): SQL =>
  sql`select c.id as key, ${siteHost(sql`s.home_url`)} as host, c.created_at as ord
      from site_claims c join sites s on s.id = c.site_id where c.status = 'pending'`

/**
 * The editorial door into Discover (ADR 0018): an operator adds a curated blog's feed and lists
 * the blog, before any blogger has claimed theirs, featuring the few the list marks so Discover
 * opens on them. One entry a request, so `bun run admin curate` shows progress and one
 * unreachable feed does not stop the rest. Applying an entry again changes nothing that is
 * already right.
 */
import { bumpSeq, currentSeq, first } from '@tela/data'
import { isTopic } from '@tela/shared'
import { sql } from 'drizzle-orm'
import type { ApiDeps } from '../deps'
import { fetchSoon } from './feeds'

export type CurateResult =
  | {
      feedId: number
      siteId: number
      created: boolean
      listing: string
      title: string | null
      topics: string[]
    }
  | { error: string }

export async function curate(
  deps: ApiDeps,
  feedUrl: string,
  topics: string[],
  featured: boolean,
  /** The blog's name where its feed gives a poor one; the feed's stands when this is null. */
  title: string | null = null,
): Promise<CurateResult> {
  const { db } = deps
  const added = await deps.ingest.addFeed({ feedUrl, actorId: null })
  if ('error' in added) return added
  const chosen = [...new Set(topics.filter(isTopic))]
  const site = await first<{ listing: string; claimed_by: string | null }>(
    db,
    sql`select listing, claimed_by from sites where id = ${added.siteId}`,
  )
  // Featured or listed, as the list says, unless a person decided otherwise: a rejected blog is
  // left alone entirely, and a claimed one's topics are its owner's to pick. Either is an
  // editor's decision for Discover, so it records the review the console's Feature and List do
  // (ADR 0041): listed, so an Unfeature leaves the pick in Discover.
  const listing = featured ? 'featured' : 'listed'
  const relist = site ? site.listing !== 'rejected' && site.listing !== listing : false
  const retopic = site?.listing !== 'rejected' && site?.claimed_by === null && chosen.length > 0
  // A claimed blog's name is its writer's, as its topics are. No fetch rewrites a blog's name
  // (it only fills one that is missing), so a name set here stays.
  const rename = title !== null
  const now = deps.clock.now()
  await db.batch([
    bumpSeq(db),
    db.run(sql`
      update sites set listing = ${listing}, review = 'listed', reviewed_at = ${now},
        updated_at = ${now}, seq = ${currentSeq}
      where id = ${added.siteId} and ${relist ? sql`true` : sql`false`}
    `),
    db.run(sql`
      update sites set title = ${title}, updated_at = ${now}, seq = ${currentSeq}
      where id = ${added.siteId} and claimed_by is null and title is not ${title}
        and ${rename ? sql`true` : sql`false`}
    `),
    db.run(
      sql`delete from site_topics where site_id = ${added.siteId} and ${retopic ? sql`true` : sql`false`}`,
    ),
    db.run(sql`
      insert into site_topics (site_id, topic)
      select ${added.siteId}, value from json_each(${JSON.stringify(retopic ? chosen : [])}) where true
    `),
  ] as never)
  const feed = await first<{ last_fetched_at: number | null }>(
    db,
    sql`select last_fetched_at from feeds where id = ${added.feedId}`,
  )
  if (feed && feed.last_fetched_at === null) {
    await fetchSoon(db, deps.jobs, added.feedId, deps.clock.now())
  }
  const after = await first<{ listing: string; title: string | null }>(
    db,
    sql`select listing, title from sites where id = ${added.siteId}`,
  )
  const stored = await db.all<{ topic: string }>(
    sql`select topic from site_topics where site_id = ${added.siteId} order by topic`,
  )
  return {
    feedId: added.feedId,
    siteId: added.siteId,
    created: added.created,
    listing: after?.listing ?? 'private',
    title: after?.title ?? null,
    topics: stored.map((t) => t.topic),
  }
}

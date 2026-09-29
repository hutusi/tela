/**
 * The editorial door into Discover (ADR 0018): an operator adds a curated blog's feed and features
 * the blog, before any blogger has claimed theirs. One entry a request, so `bun run admin curate`
 * shows progress and one unreachable feed does not stop the rest. Applying an entry again changes
 * nothing that is already right.
 */
import { bumpSeq, currentSeq, first } from '@tela/data'
import { isTopic } from '@tela/shared'
import { sql } from 'drizzle-orm'
import type { ApiDeps } from '../deps'
import { fetchSoon } from './feeds'

export type CurateResult =
  | { feedId: number; siteId: number; created: boolean; listing: string; topics: string[] }
  | { error: string }

export async function curate(
  deps: ApiDeps,
  feedUrl: string,
  topics: string[],
): Promise<CurateResult> {
  const { db } = deps
  const added = await deps.ingest.addFeed({ feedUrl, actorId: null })
  if ('error' in added) return added
  const chosen = [...new Set(topics.filter(isTopic))]
  const site = await first<{ listing: string; claimed_by: string | null }>(
    db,
    sql`select listing, claimed_by from sites where id = ${added.siteId}`,
  )
  // Featured, unless a person decided otherwise: a rejected blog is left alone entirely, and a
  // claimed one's topics are its owner's to pick.
  const feature = site?.listing === 'private' || site?.listing === 'listed'
  const retopic = site?.listing !== 'rejected' && site?.claimed_by === null && chosen.length > 0
  const now = deps.clock.now()
  await db.batch([
    bumpSeq(db),
    db.run(sql`
      update sites set listing = 'featured', updated_at = ${now}, seq = ${currentSeq}
      where id = ${added.siteId} and ${feature ? sql`true` : sql`false`}
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
  const after = await first<{ listing: string }>(
    db,
    sql`select listing from sites where id = ${added.siteId}`,
  )
  const stored = await db.all<{ topic: string }>(
    sql`select topic from site_topics where site_id = ${added.siteId} order by topic`,
  )
  return {
    feedId: added.feedId,
    siteId: added.siteId,
    created: added.created,
    listing: after?.listing ?? 'private',
    topics: stored.map((t) => t.topic),
  }
}

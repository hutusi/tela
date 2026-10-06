/**
 * What an operator does to a feed: fetch it now, pause or resume it, revive a dead one, and send
 * it through the China relay or straight from Cloudflare. A feed's row syncs to its readers.
 *
 * A fetch running when the operator pauses a feed or moves its region writes back what it read
 * at its start: the status, the region a timeout flips. So those actions break the fetch's lease
 * in their own batch (ADR 0039), and that fetch's commit is refused.
 */
import type { TelaDb } from '@tela/data'
import { DEAD_AFTER_ERRORS } from '@tela/ingest/schedule'
import type { AdminActionName } from '@tela/shared/admin'
import { sql } from 'drizzle-orm'
import { fetchSoon } from '../../feeds'
import type { ActContext, ActHandler, Inverse } from '../framework'
import { applyChange, breakLease, idOf, restoreColumns, stamped } from './common'
import { RELAY_SELECT, relayOf } from './rows'

/** The statement that cuts off a fetch of the feed in flight, once the change has applied. */
const cutOff = (db: TelaDb, feedId: number) => [
  breakLease(db, 'feed.fetch', feedId, stamped('feeds', feedId)),
]

/** Then fetch it, when the change made it due. */
async function thenFetch(ctx: ActContext, feedId: number, outcome: string) {
  if (outcome === 'done') await fetchSoon(ctx.deps.db, ctx.deps.jobs, feedId, ctx.now)
}

/** Fetch an active feed now, as a WebSub ping would ask. */
const fetchNow: ActHandler = async (ctx, id) => {
  const feedId = idOf(id)
  if (feedId === null) return 'not_found'
  const outcome = await applyChange(ctx, {
    action: 'feed.fetch',
    table: 'feeds',
    id: feedId,
    applies: sql`status = 'active'`,
    set: sql`refetch_requested_at = ${ctx.now}`,
    from: sql`json_object('refetchRequestedAt', refetch_requested_at)`,
    to: { refetchRequestedAt: ctx.now },
  })
  await thenFetch(ctx, feedId, outcome)
  return outcome
}

/** A feed an operator can pause or resume: never a merged one, which stays with its canonical feed. */
const UNMERGED = sql`merged_into is null`

/**
 * Pause a feed until an operator resumes it: no sweep fetches a paused feed, and nothing resumes
 * one on its own (the daily revival is for dead feeds).
 */
const pause: ActHandler = async (ctx, id) => {
  const feedId = idOf(id)
  if (feedId === null) return 'not_found'
  return applyChange(ctx, {
    action: 'feed.pause',
    table: 'feeds',
    id: feedId,
    applies: sql`status = 'active' and ${UNMERGED}`,
    set: sql`status = 'paused'`,
    from: sql`json_object('status', status)`,
    to: { status: 'paused' },
    after: (db) => cutOff(db, feedId),
  })
}

/** Resume a paused feed, due at once. */
const resume: ActHandler = async (ctx, id) => {
  const feedId = idOf(id)
  if (feedId === null) return 'not_found'
  return applyChange(ctx, {
    action: 'feed.resume',
    table: 'feeds',
    id: feedId,
    applies: sql`status = 'paused' and ${UNMERGED}`,
    set: sql`status = 'active', next_fetch_at = ${ctx.now}`,
    from: sql`json_object('status', status)`,
    to: { status: 'active' },
  })
}

/** Undo a pause: active again and due now, as a resume makes it. */
const unpause = restoreColumns({
  table: 'feeds',
  columns: { status: 'status' },
  set: (now) => sql`next_fetch_at = ${now}`,
})

/** Undo a resume: paused again, and a fetch the resume let start is cut off. */
const unresume = restoreColumns({
  table: 'feeds',
  columns: { status: 'status' },
  after: cutOff,
})

/**
 * Give a dead feed another chance now, as the daily revival does a week on: active, five errors
 * from dying again, and fetched at once.
 */
const revive: ActHandler = async (ctx, id) => {
  const feedId = idOf(id)
  if (feedId === null) return 'not_found'
  const outcome = await applyChange(ctx, {
    action: 'feed.revive',
    table: 'feeds',
    id: feedId,
    applies: sql`status = 'dead'`,
    set: sql`status = 'active', error_count = ${DEAD_AFTER_ERRORS - 5},
      next_fetch_at = ${ctx.now}`,
    from: sql`json_object('status', status, 'errorCount', error_count)`,
    to: { status: 'active', errorCount: DEAD_AFTER_ERRORS - 5 },
  })
  await thenFetch(ctx, feedId, outcome)
  return outcome
}

/** A feed's region as an undo restores it: the region, when it flipped, and its timeouts. */
const REGION_FROM = sql`json_object('fetchRegion', fetch_region,
  'regionFlippedAt', region_flipped_at, 'timeoutStreak', timeout_streak)`

/**
 * Fetch a feed through the China relay for good. `region_flipped_at` stays null, which is what
 * keeps the daily reprobe (`region_flipped_at < a week ago`) from trying it directly again; that
 * reprobe is for flips the timeouts made. A feed the timeouts flipped can be pinned this way too.
 * `no_relay` while tela-jobs runs without one: the feed could not be fetched at all.
 */
const useRelay: ActHandler = async (ctx, id) => {
  const feedId = idOf(id)
  if (feedId === null) return 'not_found'
  const { db } = ctx.deps
  if (!relayOf(await db.all(RELAY_SELECT))) return 'no_relay'
  return applyChange(ctx, {
    action: 'feed.relay',
    table: 'feeds',
    id: feedId,
    applies: sql`${UNMERGED} and (fetch_region <> 'cn' or region_flipped_at is not null)`,
    set: sql`fetch_region = 'cn', region_flipped_at = null, timeout_streak = 0`,
    from: REGION_FROM,
    to: { fetchRegion: 'cn', regionFlippedAt: null, timeoutStreak: 0 },
    after: (db) => cutOff(db, feedId),
  })
}

/**
 * Fetch a feed straight from Cloudflare again, its timeouts counted afresh: a streak the relay
 * left would list it under Timing out at once and send it back to the relay on its first timeout.
 */
const useGlobal: ActHandler = async (ctx, id) => {
  const feedId = idOf(id)
  if (feedId === null) return 'not_found'
  return applyChange(ctx, {
    action: 'feed.global',
    table: 'feeds',
    id: feedId,
    applies: sql`${UNMERGED} and fetch_region = 'cn'`,
    set: sql`fetch_region = 'global', region_flipped_at = null, timeout_streak = 0`,
    from: REGION_FROM,
    to: { fetchRegion: 'global', regionFlippedAt: null, timeoutStreak: 0 },
    after: (db) => cutOff(db, feedId),
  })
}

/**
 * Put a feed's region back while it is still the one the action set. The timeout streak is the
 * fetches' own count, moved by every one since: it stays as they left it, never put back to a
 * value older than they are.
 */
const restoreRegion = restoreColumns({
  table: 'feeds',
  columns: {
    fetchRegion: 'fetch_region',
    regionFlippedAt: 'region_flipped_at',
  },
  match: ['fetchRegion', 'regionFlippedAt'],
  after: cutOff,
})

export const feedActions = {
  'feed.fetch': fetchNow,
  'feed.pause': pause,
  'feed.resume': resume,
  'feed.revive': revive,
  'feed.relay': useRelay,
  'feed.global': useGlobal,
} satisfies Partial<Record<AdminActionName, ActHandler>>

export const feedInverses = {
  'feed.pause': unpause,
  'feed.resume': unresume,
  'feed.relay': restoreRegion,
  'feed.global': restoreRegion,
} satisfies Partial<Record<AdminActionName, Inverse>>

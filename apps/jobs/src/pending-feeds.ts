/**
 * `member.pendingFeeds` (ADR 0063): the feeds an OPML import named that were new to Tela beyond
 * the member's day wait in `pending_feeds`, and this adds them on the days after, as many a day as
 * `member.feedsPerDay` allows, within the subscription cap. Keyed by member, so one run brings one
 * member's feeds; a feed someone else added meanwhile is one Tela has, and subscribes free.
 *
 * The run reads the member's waiting rows, then writes in one fenced batch (`addPendingFeeds`) by
 * the statements the import itself runs: a holder that lost its lease adds nothing, and a run
 * again adds nothing twice, since a feed added is one Tela has and a subscription made is held.
 * Nothing is fetched here; the feed sweep fetches each new feed as it fetches an import's.
 */
import {
  addPendingFeeds,
  type BroughtFeed,
  isFenceRefusal,
  type Lease,
  pendingFeedsOf,
} from '@tela/data'
import { siteKeyOf } from '@tela/shared'
import type { StepResult, WorkContext } from './kinds'

export const PENDING_FEEDS_TTL_MS = 2 * 60_000

export async function pendingFeedsJob(
  ctx: WorkContext,
  lease: Lease,
): Promise<StepResult & { added?: number; subscribed?: number; waiting?: number }> {
  const userId = lease.key
  // None left (the member followed them meanwhile) still commits, to release the lease.
  const rows = await pendingFeedsOf(ctx.db, userId)
  const feeds: BroughtFeed[] = []
  const drop: string[] = []
  for (const row of rows) {
    const origin = siteKeyOf(row.feed_url)
    if (origin) {
      feeds.push({
        feedUrl: row.feed_url,
        host: new URL(row.feed_url).hostname.toLowerCase(),
        origin,
        title: row.title,
      })
    } else {
      drop.push(row.feed_url)
    }
  }
  try {
    const brought = await addPendingFeeds(ctx.db, {
      lease,
      userId,
      feeds,
      drop,
      now: ctx.clock.now(),
    })
    return {
      status: 'done',
      added: brought.added,
      subscribed: brought.subscribed,
      waiting: brought.waiting,
    }
  } catch (err) {
    if (isFenceRefusal(err)) return { status: 'lost' }
    throw err
  }
}

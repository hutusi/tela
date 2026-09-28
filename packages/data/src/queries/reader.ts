/** A member's subscriptions (the API grows the rest of the reader's writes on these). */
import { sql } from 'drizzle-orm'
import type { TelaDb } from '../db'
import { subscriptions } from '../schema'
import { bumpSeq, currentSeq } from '../seq'
import { recountReaders } from './sites'

const siteOfFeed = (feedId: number) => sql`(select site_id from feeds where id = ${feedId})`

/** Subscribe (or resubscribe); articles already stored count as unread from here on. */
export async function subscribe(db: TelaDb, userId: string, feedId: number, now: number) {
  await db.batch([
    bumpSeq(db),
    db
      .insert(subscriptions)
      .values({ userId, feedId, createdAt: now, updatedAt: now, seq: currentSeq })
      .onConflictDoUpdate({
        target: [subscriptions.userId, subscriptions.feedId],
        set: { deletedAt: null, updatedAt: now, seq: currentSeq },
      }),
    ...recountReaders(db, siteOfFeed(feedId), now),
  ])
}

export async function unsubscribe(db: TelaDb, userId: string, feedId: number, now: number) {
  await db.batch([
    bumpSeq(db),
    db.run(sql`
      update subscriptions set deleted_at = ${now}, updated_at = ${now}, seq = ${currentSeq}
      where user_id = ${userId} and feed_id = ${feedId} and deleted_at is null
    `),
    ...recountReaders(db, siteOfFeed(feedId), now),
  ])
}

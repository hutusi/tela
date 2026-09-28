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

/**
 * Subscribe to many feeds at once (an OPML import), in one batch. Returns how many subscriptions
 * are new or revived; ones already active are left as they are.
 */
export async function subscribeMany(
  db: TelaDb,
  userId: string,
  feedIds: number[],
  now: number,
): Promise<number> {
  if (feedIds.length === 0) return 0
  const ids = JSON.stringify(feedIds)
  const results = await db.batch([
    bumpSeq(db),
    db.all(sql`
      insert into subscriptions (user_id, feed_id, watermark_id, created_at, updated_at, seq)
      select ${userId}, value, 0, ${now}, ${now}, ${currentSeq} from json_each(${ids}) where true
      on conflict (user_id, feed_id) do update set
        deleted_at = null, updated_at = excluded.updated_at, seq = excluded.seq
      where subscriptions.deleted_at is not null
      returning feed_id
    `),
    ...recountReaders(
      db,
      sql`select distinct site_id from feeds where id in (select value from json_each(${ids}))`,
      now,
    ),
  ] as never)
  return ((results as unknown[])[1] as unknown[]).length
}

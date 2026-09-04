import { and, eq, inArray, lt, or, sql } from 'drizzle-orm'
import type { Db } from '../client'
import { websubSubscriptions } from '../schema'

export type WebsubRow = typeof websubSubscriptions.$inferSelect

/** Renew this long before a lease ends. */
export const WEBSUB_RENEW_BEFORE_SEC = 2 * 24 * 3600
/** A pending request the hub never verified is retried after this long. */
export const WEBSUB_PENDING_RETRY_SEC = 24 * 3600
/** A failed subscription is retried after this long. */
export const WEBSUB_FAILED_RETRY_SEC = 7 * 24 * 3600

export async function getWebsub(db: Db, feedId: number): Promise<WebsubRow | null> {
  const [row] = await db
    .select()
    .from(websubSubscriptions)
    .where(eq(websubSubscriptions.feedId, feedId))
  return row ?? null
}

/** Record a (re)subscription request; the secret is replaced only when the caller passes a new one. */
export async function upsertWebsubPending(
  db: Db,
  values: { feedId: number; hubUrl: string; topicUrl: string; secret: string },
  now: Date = new Date(),
): Promise<WebsubRow> {
  const [row] = await db
    .insert(websubSubscriptions)
    .values({ ...values, status: 'pending', requestedAt: now })
    .onConflictDoUpdate({
      target: websubSubscriptions.feedId,
      set: {
        hubUrl: values.hubUrl,
        topicUrl: values.topicUrl,
        secret: values.secret,
        status: 'pending',
        requestedAt: now,
        lastError: null,
      },
    })
    .returning()
  if (!row) throw new Error('websub upsert returned nothing')
  return row
}

/** The hub verified the intent: active for `leaseSeconds`. Null when nothing was pending. */
export async function markWebsubVerified(
  db: Db,
  feedId: number,
  topicUrl: string,
  leaseSeconds: number,
  now: Date = new Date(),
): Promise<WebsubRow | null> {
  const [row] = await db
    .update(websubSubscriptions)
    .set({
      status: 'active',
      leaseUntil: new Date(now.getTime() + leaseSeconds * 1000),
      verifiedAt: now,
      lastError: null,
    })
    .where(
      and(
        eq(websubSubscriptions.feedId, feedId),
        eq(websubSubscriptions.topicUrl, topicUrl),
        inArray(websubSubscriptions.status, ['pending', 'active']),
      ),
    )
    .returning()
  return row ?? null
}

export async function markWebsubFailed(db: Db, feedId: number, error: string): Promise<void> {
  await db
    .update(websubSubscriptions)
    .set({ status: 'failed', lastError: error.slice(0, 500) })
    .where(eq(websubSubscriptions.feedId, feedId))
}

/** Feeds whose subscription should be (re)requested: leases ending soon, stale pendings, old failures. */
export async function websubDueForRenewal(db: Db, now: Date = new Date()): Promise<number[]> {
  const at = (sec: number) => new Date(now.getTime() + sec * 1000)
  const rows = await db
    .select({ feedId: websubSubscriptions.feedId })
    .from(websubSubscriptions)
    .where(
      or(
        and(
          eq(websubSubscriptions.status, 'active'),
          lt(websubSubscriptions.leaseUntil, at(WEBSUB_RENEW_BEFORE_SEC)),
        ),
        and(
          eq(websubSubscriptions.status, 'pending'),
          lt(websubSubscriptions.requestedAt, at(-WEBSUB_PENDING_RETRY_SEC)),
        ),
        and(
          eq(websubSubscriptions.status, 'failed'),
          lt(websubSubscriptions.updatedAt, at(-WEBSUB_FAILED_RETRY_SEC)),
        ),
      ),
    )
    .orderBy(sql`${websubSubscriptions.leaseUntil} nulls first`)
  return rows.map((r) => r.feedId)
}

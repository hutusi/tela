/**
 * Ask a feed's hub to push notifications to the web app's callback. The row goes to `pending`
 * before the request so the hub's verification GET (which may arrive within milliseconds) finds
 * it; the callback route flips it to `active` with the granted lease.
 */
import { type Db, feeds } from '@tela/db'
import {
  getWebsub,
  markWebsubFailed,
  upsertWebsubPending,
  WEBSUB_FAILED_RETRY_SEC,
  WEBSUB_PENDING_RETRY_SEC,
  WEBSUB_RENEW_BEFORE_SEC,
  type WebsubRow,
} from '@tela/db/queries'
import { newWebsubSecret, requestHubSubscription } from '@tela/ingest'
import { eq } from 'drizzle-orm'

export type WebsubDeps = {
  db: Db
  /** Public origin of the web app; the callback is `<publicUrl>/api/websub/<feedId>`. */
  publicUrl: string
  fetch?: typeof fetch
  timeoutMs?: number
  allowPrivateHosts?: boolean
}

export type WebsubOutcome = {
  status: 'requested' | 'skipped' | 'failed'
  reason?: string
  hubUrl?: string
}

/** Whether a (re)subscription request is worth sending now. */
export function websubNeedsRequest(row: WebsubRow | null, now: Date = new Date()): boolean {
  if (!row) return true
  const age = (at: Date | null) => (at ? (now.getTime() - at.getTime()) / 1000 : Infinity)
  switch (row.status) {
    case 'active':
      return (
        row.leaseUntil === null ||
        row.leaseUntil.getTime() - now.getTime() < WEBSUB_RENEW_BEFORE_SEC * 1000
      )
    case 'pending':
      return age(row.requestedAt) > WEBSUB_PENDING_RETRY_SEC
    case 'failed':
      return age(row.updatedAt) > WEBSUB_FAILED_RETRY_SEC
  }
}

export async function subscribeFeedToHub(deps: WebsubDeps, feedId: number): Promise<WebsubOutcome> {
  const [feed] = await deps.db
    .select({ id: feeds.id, feedUrl: feeds.feedUrl, hubUrl: feeds.hubUrl, status: feeds.status })
    .from(feeds)
    .where(eq(feeds.id, feedId))
  if (!feed) return { status: 'skipped', reason: 'feed not found' }
  if (!feed.hubUrl) return { status: 'skipped', reason: 'no hub' }
  if (feed.status !== 'active') return { status: 'skipped', reason: `feed is ${feed.status}` }

  const existing = await getWebsub(deps.db, feedId)
  // Keep the secret across renewals so notifications in flight still verify.
  const secret = existing?.secret ?? newWebsubSecret()
  const callbackUrl = new URL(`/api/websub/${feedId}`, deps.publicUrl).toString()
  await upsertWebsubPending(deps.db, {
    feedId,
    hubUrl: feed.hubUrl,
    topicUrl: feed.feedUrl,
    secret,
  })
  const result = await requestHubSubscription({
    hubUrl: feed.hubUrl,
    topicUrl: feed.feedUrl,
    callbackUrl,
    secret,
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
    ...(deps.timeoutMs ? { timeoutMs: deps.timeoutMs } : {}),
    ...(deps.allowPrivateHosts ? { allowPrivateHosts: true } : {}),
  })
  if (!result.ok) {
    await markWebsubFailed(deps.db, feedId, result.error)
    return { status: 'failed', reason: result.error, hubUrl: feed.hubUrl }
  }
  return { status: 'requested', hubUrl: feed.hubUrl }
}

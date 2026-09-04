import type { Db } from '@tela/db'
import { createJobSender } from '@tela/db/queue'

/**
 * Best-effort enqueue of an immediate fetch. The scheduler would pick a new feed up within a
 * minute anyway; this only makes "add a feed" feel instant. Failures (queue schema missing on a
 * fresh database, transient errors) are logged and ignored.
 */
export async function enqueueFeedFetch(db: Db, feedId: number): Promise<void> {
  try {
    const jobId = await createJobSender(db).send(
      'feed.fetch',
      { feedId },
      { singletonKey: String(feedId) },
    )
    console.info('[tela] enqueued feed.fetch', { feedId, jobId })
  } catch (err) {
    console.warn('[tela] could not enqueue feed.fetch', { feedId, err: String(err) })
  }
}

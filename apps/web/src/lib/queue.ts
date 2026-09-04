import type { Db } from '@tela/db'
import { createJobSender } from '@tela/db/queue'

/**
 * Best-effort enqueue of an immediate fetch. The scheduler would pick a new feed up within a
 * minute anyway; this only makes "add a feed" feel instant. Failures (queue schema missing on a
 * fresh database, transient errors) are logged and ignored.
 */
export async function enqueueFeedFetch(db: Db, feedId: number): Promise<void> {
  await enqueue(db, 'feed.fetch', { feedId }, String(feedId))
}

/**
 * First open of an article from a summary-only feed: fetch its page for the full text. The
 * worker stamps the article whatever the outcome, so this happens once per article; a failed
 * enqueue simply means the next open tries again.
 */
export async function enqueueArticleExtract(db: Db, articleId: number): Promise<void> {
  await enqueue(db, 'article.extract', { articleId }, String(articleId))
}

async function enqueue(
  db: Db,
  queue: string,
  data: Record<string, unknown>,
  singletonKey: string,
): Promise<void> {
  try {
    const jobId = await createJobSender(db).send(queue, data, { singletonKey })
    console.info(`[tela] enqueued ${queue}`, { ...data, jobId })
  } catch (err) {
    console.warn(`[tela] could not enqueue ${queue}`, { ...data, err: String(err) })
  }
}

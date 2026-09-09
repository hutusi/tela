/**
 * One-off ingestion commands against DATABASE_URL, without the queue:
 *   bun run src/cli.ts discover <url>
 *   bun run src/cli.ts fetch <feedUrl>       # ensureFeed + fetchFeed
 *   bun run src/cli.ts extract <articleId>
 */
import { createDb, type Db } from '@tela/db'
import { discoverFeeds, ensureFeed, fetchFeed } from '@tela/ingest'
import { extractArticleContent } from '@tela/ingest/extract'
import { sql } from 'drizzle-orm'
import { loadConfig } from './config'
import { createHttp, createOutboundFetch } from './context'
import { titleEnqueuer } from './jobs/fetch-feed'
import { QUEUES } from './queues'

const [command, arg] = process.argv.slice(2)
const config = loadConfig({ ...process.env, WORKER_ROLES: 'fetch' })
const http = createHttp(config, createOutboundFetch())

if (!command || !arg) {
  console.error('usage: cli.ts <discover|fetch|extract> <url|id>')
  process.exit(2)
}

if (command === 'discover') {
  const found = await discoverFeeds(http, arg)
  console.log(JSON.stringify(found, null, 2))
  process.exit(0)
}

/**
 * Queues are created by the worker's ensureQueues(), which this one-off path never runs, and
 * sending to a missing queue throws. The enqueue happens inside the article's own transaction,
 * so on a database the worker has never touched that throw would roll the article insert back.
 * Check once and seed without title jobs rather than lose the ingest entirely.
 */
async function titleJobsAvailable(db: Db): Promise<boolean> {
  const rows = await db.execute<{ name: string }>(
    sql`select name from pgboss.queue where name = ${QUEUES.translateTitle}`,
  )
  if (rows.length > 0) return true
  console.warn(`queue ${QUEUES.translateTitle} does not exist; seeding without title jobs`)
  return false
}

const db = createDb(config.DATABASE_URL as string, { max: 2 })
try {
  if (command === 'fetch') {
    const ensured = await ensureFeed(db, { feedUrl: arg })
    // Title jobs are the fetch job's doing, not fetchFeed's, so a hand-run fetch that forgets
    // them seeds articles no reader ever sees translated and nothing retries.
    const titles = { articles: 0, jobs: 0 }
    const result = await fetchFeed(db, http, ensured.feedId, {
      ...((await titleJobsAvailable(db)) ? { onArticleStored: titleEnqueuer(titles) } : {}),
    })
    console.log(JSON.stringify({ ...ensured, ...result, titleJobs: titles.jobs }, null, 2))
  } else if (command === 'extract') {
    const result = await extractArticleContent(db, http, Number(arg))
    console.log(JSON.stringify(result, null, 2))
  } else {
    console.error(`unknown command ${command}`)
    process.exitCode = 2
  }
} finally {
  await db.close()
}

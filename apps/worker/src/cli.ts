/**
 * One-off ingestion and repair commands against DATABASE_URL. Fetch can run before pg-boss;
 * repair-titles requires its queue.
 *   bun run src/cli.ts discover <url>
 *   bun run src/cli.ts fetch <feedUrl>       # ensureFeed + fetchFeed
 *   bun run src/cli.ts extract <articleId>
 *   bun run src/cli.ts repair-titles [limit]
 */
import { createDb } from '@tela/db'
import { discoverFeeds, ensureFeed, fetchFeed } from '@tela/ingest'
import { extractArticleContent } from '@tela/ingest/extract'
import { loadConfig } from './config'
import { createHttp, createOutboundFetch } from './context'
import {
  DEFAULT_TITLE_REPAIR_LIMIT,
  MAX_TITLE_REPAIR_LIMIT,
  repairMissingTitleJobs,
  titleEnqueuer,
  titleQueueAvailable,
} from './title-jobs'

const [command, arg, ...extra] = process.argv.slice(2)
const config = loadConfig({ ...process.env, WORKER_ROLES: 'fetch' })
const http = createHttp(config, createOutboundFetch())

const repair = command === 'repair-titles'
if (!command || (!repair && !arg) || extra.length > 0) {
  console.error('usage: cli.ts <discover|fetch|extract> <url|id> | cli.ts repair-titles [limit]')
  process.exit(2)
}

if (command === 'discover') {
  const found = await discoverFeeds(http, arg as string)
  console.log(JSON.stringify(found, null, 2))
  process.exit(0)
}

const db = createDb(config.DATABASE_URL as string, { max: 2 })
try {
  if (command === 'fetch') {
    const ensured = await ensureFeed(db, { feedUrl: arg as string })
    // Title jobs are the fetch job's doing, not fetchFeed's, so a hand-run fetch that forgets
    // them seeds articles no reader ever sees translated and nothing retries.
    const titles = { articles: 0, jobs: 0 }
    const titlesAvailable = await titleQueueAvailable(db)
    if (!titlesAvailable) {
      console.warn('queue translate.title does not exist; seeding without title jobs')
    }
    const result = await fetchFeed(db, http, ensured.feedId, {
      ...(titlesAvailable ? { onArticleStored: titleEnqueuer(titles) } : {}),
    })
    console.log(JSON.stringify({ ...ensured, ...result, titleJobs: titles.jobs }, null, 2))
  } else if (command === 'extract') {
    const result = await extractArticleContent(db, http, Number(arg))
    console.log(JSON.stringify(result, null, 2))
  } else if (repair) {
    const limit = arg === undefined ? DEFAULT_TITLE_REPAIR_LIMIT : Number(arg)
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_TITLE_REPAIR_LIMIT) {
      console.error(`repair-titles limit must be an integer from 1 to ${MAX_TITLE_REPAIR_LIMIT}`)
      process.exitCode = 2
    } else {
      const result = await repairMissingTitleJobs(db, limit)
      console.log(JSON.stringify({ command: 'repair-titles', limit, ...result }, null, 2))
    }
  } else {
    console.error(`unknown command ${command}`)
    process.exitCode = 2
  }
} finally {
  await db.close()
}

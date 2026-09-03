/**
 * One-off ingestion commands against DATABASE_URL, without the queue:
 *   bun run src/cli.ts discover <url>
 *   bun run src/cli.ts fetch <feedUrl>       # ensureFeed + fetchFeed
 *   bun run src/cli.ts extract <articleId>
 */
import { createDb } from '@tela/db'
import { discoverFeeds, ensureFeed, fetchFeed } from '@tela/ingest'
import { extractArticleContent } from '@tela/ingest/extract'
import { loadConfig } from './config'
import { createHttp } from './context'

const [command, arg] = process.argv.slice(2)
const config = loadConfig({ ...process.env, WORKER_ROLES: 'fetch' })
const http = createHttp(config)

if (!command || !arg) {
  console.error('usage: cli.ts <discover|fetch|extract> <url|id>')
  process.exit(2)
}

if (command === 'discover') {
  const found = await discoverFeeds(http, arg)
  console.log(JSON.stringify(found, null, 2))
  process.exit(0)
}

const db = createDb(config.DATABASE_URL as string, { max: 2 })
try {
  if (command === 'fetch') {
    const ensured = await ensureFeed(db, { feedUrl: arg })
    const result = await fetchFeed(db, http, ensured.feedId)
    console.log(JSON.stringify({ ...ensured, ...result }, null, 2))
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

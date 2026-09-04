/**
 * Seed the e2e database: two feeds fetched from the fixture server and subscribed by the
 * development user. Requires DATABASE_URL and a running fixture server.
 *   bun run e2e/seed.ts
 */
import { createDb } from '@tela/db'
import { subscribe } from '@tela/db/queries'
import { createHttpClient, ensureFeed, fetchFeed } from '@tela/ingest'

const DEV_USER_ID = '00000000-0000-4000-8000-000000000001'
const fixtures = process.env.E2E_FIXTURE_URL ?? 'http://127.0.0.1:4790'
const url = process.env.DATABASE_URL
if (!url) throw new Error('DATABASE_URL is required')

const db = createDb(url, { max: 2 })
const http = createHttpClient({
  userAgent: 'TelaE2E/1.0',
  politenessMs: 0,
  allowPrivateHosts: true,
})
try {
  for (const path of ['/hutusi.xml', '/jvns.xml']) {
    const { feedId } = await ensureFeed(db, { feedUrl: `${fixtures}${path}` })
    const result = await fetchFeed(db, http, feedId)
    await subscribe(db, DEV_USER_ID, feedId)
    console.log(JSON.stringify({ path, feedId, ...result }))
  }
} finally {
  await db.close()
}

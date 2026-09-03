/**
 * Start a throwaway, fully migrated Postgres for local development without Docker.
 *   bun run --filter @tela/db local-db            # random port
 *   bun run --filter @tela/db local-db --port 54322
 * Prints DATABASE_URL and keeps running until Ctrl+C.
 */
import { createDb } from '../src/client'
import { prepareDatabase, startLocalCluster } from '../src/testing/local-postgres'

const portFlag = process.argv.indexOf('--port')
const port = portFlag >= 0 ? Number(process.argv[portFlag + 1]) : undefined

const cluster = await startLocalCluster(port ? { port } : {})
const db = createDb(cluster.url, { max: 2 })
await prepareDatabase(db)
await db.close()

console.log(`DATABASE_URL=${cluster.url}`)
console.log('local Postgres ready; press Ctrl+C to stop')

let stopping = false
const stop = async () => {
  if (stopping) return
  stopping = true
  await cluster.stop()
  process.exit(0)
}
process.on('SIGINT', () => void stop())
process.on('SIGTERM', () => void stop())
setInterval(() => {}, 60_000)

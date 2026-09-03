import { createDb } from '@tela/db'
import { loadConfig } from './config'
import { log, setLogLevel } from './logger'

async function main() {
  const config = loadConfig()
  setLogLevel(config.LOG_LEVEL)
  log.info('worker starting', { roles: config.roles, node: process.version })

  const stops: Array<() => Promise<void>> = []

  if (config.needsDb && config.DATABASE_URL) {
    const db = createDb(config.DATABASE_URL, { max: 5 })
    const [row] = await db.execute<{ now: string }>('select now() as now')
    log.info('database connected', { now: row?.now })
    stops.push(() => db.close())
    // Phase 3 wires pg-boss queues here, one boss.work() per role.
  }

  const heartbeat = setInterval(() => {
    log.debug('heartbeat', { roles: config.roles })
  }, config.HEARTBEAT_SEC * 1000)
  stops.push(async () => clearInterval(heartbeat))

  let stopping = false
  const shutdown = async (signal: string) => {
    if (stopping) return
    stopping = true
    log.info('shutting down', { signal })
    for (const stop of stops.reverse()) {
      try {
        await stop()
      } catch (err) {
        log.error('stop failed', { err: String(err) })
      }
    }
    process.exit(0)
  }
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))
}

main().catch((err) => {
  log.error('worker failed to start', { err: err instanceof Error ? err.stack : String(err) })
  process.exit(1)
})

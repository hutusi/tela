import type { Db } from '@tela/db'
import { createHttpClient, type HttpClient } from '@tela/ingest'
import type { PgBoss } from 'pg-boss'
import type { WorkerConfig } from './config'

/** Everything a job handler needs. Built once per process. */
export type WorkerContext = {
  config: WorkerConfig
  db: Db
  boss: PgBoss
  http: HttpClient
}

export function createHttp(config: WorkerConfig): HttpClient {
  return createHttpClient({
    userAgent: config.WORKER_USER_AGENT,
    timeoutMs: config.FETCH_TIMEOUT_MS,
    maxBytes: 5 * 1024 * 1024,
    politenessMs: 2000,
    allowPrivateHosts: process.env.WORKER_ALLOW_PRIVATE_HOSTS === '1',
  })
}

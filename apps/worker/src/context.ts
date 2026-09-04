import type { Db } from '@tela/db'
import { createHttpClient, createRelayClient, type HttpClient } from '@tela/ingest'
import { configFromEnv, createTranslator, type Translator } from '@tela/llm'
import type { PgBoss } from 'pg-boss'
import { type AssetStore, createStoreFromEnv } from './assets/store'
import type { WorkerConfig } from './config'
import { createSafeFetch } from './net/safe-fetch'

/** Everything a job handler needs. Built once per process. */
export type WorkerContext = {
  config: WorkerConfig
  db: Db
  boss: PgBoss
  http: HttpClient
  /** Outbound fetch pinned to vetted addresses; every user-controlled URL goes through it. */
  fetch: typeof fetch
  translator: Translator
  /** Favicon/cover store; null disables the assets job's uploads. */
  assets: AssetStore | null
}

export function allowPrivateHosts(): boolean {
  return process.env.WORKER_ALLOW_PRIVATE_HOSTS === '1'
}

/** One DNS-pinned fetch for the process; the relay client and the S3 store keep the global one. */
export function createOutboundFetch(): typeof fetch {
  return createSafeFetch({ allowPrivateHosts: allowPrivateHosts() })
}

export function createHttp(config: WorkerConfig, fetchImpl: typeof fetch): HttpClient {
  const relay =
    config.RELAY_URL && config.RELAY_SECRET
      ? createRelayClient({ relayUrl: config.RELAY_URL, secret: config.RELAY_SECRET })
      : null
  return createHttpClient({
    userAgent: config.WORKER_USER_AGENT,
    timeoutMs: config.FETCH_TIMEOUT_MS,
    maxBytes: 5 * 1024 * 1024,
    politenessMs: 2000,
    allowPrivateHosts: allowPrivateHosts(),
    fetch: fetchImpl,
    ...(relay ? { relay } : {}),
  })
}

export function createAssetsFromEnv(): AssetStore | null {
  return createStoreFromEnv(process.env)
}

/** Translator from LLM_PROVIDER / keys; the mock when no key is configured. */
export function createTranslatorFromEnv(): Translator {
  return createTranslator(configFromEnv(process.env))
}

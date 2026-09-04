import type { PgDatabase } from 'drizzle-orm/pg-core'
import { drizzle, type PostgresJsQueryResultHKT } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema'

export type DbOptions = {
  /** Pool size. Cloudflare Workers should use 1 and create a client per request. */
  max?: number
  /** Disable prepared statements when going through a transaction-mode pooler. */
  prepare?: boolean
  /** Override TLS; by default it is chosen from the host (see sslModeFor). */
  ssl?: false | 'require'
}

/**
 * Supabase and other hosted Postgres require TLS. Local clusters do not offer it, and neither
 * does a Hyperdrive endpoint (`*.hyperdrive.local`): Hyperdrive terminates TLS to the origin
 * itself, and a client that insists on TLS hangs on the handshake until its connect timeout.
 */
export function sslModeFor(url: string): false | 'require' {
  let host = ''
  try {
    host = new URL(url).hostname
  } catch {
    return 'require'
  }
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]') {
    return false
  }
  if (host.endsWith('.hyperdrive.local')) return false
  return 'require'
}

export function createDb(url: string, options: DbOptions = {}) {
  const client = postgres(url, {
    max: options.max ?? 10,
    prepare: options.prepare ?? true,
    ssl: options.ssl ?? sslModeFor(url),
    onnotice: () => {},
  })
  const db = drizzle(client, { schema, casing: 'snake_case' })
  return Object.assign(db, {
    close: () => client.end({ timeout: 5 }),
    raw: client,
  })
}

export type Db = ReturnType<typeof createDb>

/** A Db or the `tx` inside db.transaction(): what query helpers and the job sender need. */
export type DbExecutor = PgDatabase<PostgresJsQueryResultHKT, typeof schema>

/** The handle passed to the callback of db.transaction(). */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]

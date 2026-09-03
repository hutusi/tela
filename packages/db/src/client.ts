import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema'

export type DbOptions = {
  /** Pool size. Cloudflare Workers should use 1 and create a client per request. */
  max?: number
  /** Disable prepared statements when going through a transaction-mode pooler. */
  prepare?: boolean
}

export function createDb(url: string, options: DbOptions = {}) {
  const client = postgres(url, {
    max: options.max ?? 10,
    prepare: options.prepare ?? true,
    // Supabase direct connections require TLS; local Postgres does not offer it.
    ssl: /localhost|127\.0\.0\.1/.test(url) ? false : 'require',
    onnotice: () => {},
  })
  const db = drizzle(client, { schema, casing: 'snake_case' })
  return Object.assign(db, {
    close: () => client.end({ timeout: 5 }),
    raw: client,
  })
}

export type Db = ReturnType<typeof createDb>

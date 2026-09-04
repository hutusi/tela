import { getCloudflareContext } from '@opennextjs/cloudflare'
import { createDb, type Db } from '@tela/db'
import { cache } from 'react'
import { onCloudflare } from './env'

/**
 * The only place that knows about Cloudflare bindings. On Workers each request gets its
 * own client (Hyperdrive pools behind it); elsewhere a process-wide client is reused.
 */
let shared: Db | undefined

async function hyperdriveUrl(): Promise<string | undefined> {
  if (!(await onCloudflare())) return undefined
  try {
    const { env } = await getCloudflareContext({ async: true })
    return (env as CloudflareEnv).HYPERDRIVE?.connectionString
  } catch {
    return undefined
  }
}

export const getDb = cache(async (): Promise<Db> => {
  // An explicit DATABASE_URL wins (local dev, tests, non-Cloudflare hosts); on Workers it is
  // unset and the Hyperdrive binding supplies the connection string.
  const url = process.env.DATABASE_URL
  if (url) {
    shared ??= createDb(url, { max: 5 })
    return shared
  }
  const fromBinding = await hyperdriveUrl()
  if (fromBinding) {
    // Hyperdrive's endpoint is plain TCP; it holds the TLS session to the origin.
    return createDb(fromBinding, { max: 1, ssl: false })
  }
  throw new Error('DATABASE_URL is not set and no HYPERDRIVE binding is available')
})

export function isDatabaseConfigured(): boolean {
  return Boolean(process.env.DATABASE_URL)
}

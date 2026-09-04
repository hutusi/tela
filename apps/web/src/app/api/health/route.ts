import { sql } from 'drizzle-orm'
import { getDb } from '@/lib/platform/db'
import { isDevAuthEnabled, onCloudflare } from '@/lib/platform/env'

export const dynamic = 'force-dynamic'

/** Liveness check for uptime monitors; also says which runtime and auth mode are active. */
export async function GET(): Promise<Response> {
  let database = false
  let error: string | null = null
  const started = Date.now()
  try {
    const db = await getDb()
    await db.execute(sql`select 1`)
    database = true
  } catch (err) {
    database = false
    // The reason, never the connection string: driver errors quote hosts, not credentials.
    error = (err instanceof Error ? `${err.name}: ${err.message}` : String(err)).slice(0, 200)
  }
  const body = {
    ok: database,
    database,
    databaseMs: Date.now() - started,
    error,
    cloudflare: await onCloudflare(),
    devAuth: await isDevAuthEnabled(),
    time: new Date().toISOString(),
  }
  return Response.json(body, {
    status: database ? 200 : 503,
    headers: { 'cache-control': 'no-store' },
  })
}

import { createServerClient } from '@supabase/ssr'
import { type NextRequest, NextResponse } from 'next/server'
import type { SupabaseConfig } from './supabase-config'

/**
 * Refresh the Supabase session once per request and carry the rotated cookies both downstream
 * (on the request, for Server Components) and back to the browser (on the response).
 *
 * This is the @supabase/ssr pattern for a request proxy. Server Components cannot write
 * cookies, so a refresh that happens while rendering one is lost; with refresh-token rotation
 * on, Supabase has by then revoked the token the browser still holds, and the next request
 * logs the reader out. `deps.fetch` exists for tests.
 */
export async function refreshSessionCookies(
  request: NextRequest,
  config: SupabaseConfig,
  deps: { fetch?: typeof fetch } = {},
): Promise<NextResponse> {
  let response = NextResponse.next({ request })
  const client = createServerClient(config.url, config.anonKey, {
    ...(deps.fetch ? { global: { fetch: deps.fetch } } : {}),
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (list) => {
        for (const { name, value, options } of list) {
          if (options?.maxAge === 0) request.cookies.delete(name)
          else request.cookies.set(name, value)
        }
        // The forwarded request headers are snapshotted when the response is created, so a
        // fresh response is needed once the request cookies changed.
        response = NextResponse.next({ request })
        for (const { name, value, options } of list) response.cookies.set(name, value, options)
      },
    },
  })
  await client.auth.getClaims()
  return response
}

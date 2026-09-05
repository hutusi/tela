import { type NextRequest, NextResponse } from 'next/server'
import { isDevAuthEnabled } from '@/lib/platform/env'
import { refreshSessionCookies } from '@/lib/session-refresh'
import { supabaseConfig } from '@/lib/supabase-config'

/**
 * Keeps sessions alive (ADR 0012). Pages verify the session with getClaims(), which also
 * refreshes an expiring one, but a Server Component cannot persist the refreshed cookies;
 * doing the refresh here, where both the downstream request and the response can carry them,
 * is what stops readers from being logged out an hour after signing in.
 *
 * This is the edge-runtime `middleware.ts` form rather than Next 16's Node `proxy.ts`:
 * Turbopack 16.3 panics while chunking a Node proxy that imports @supabase/ssr, and OpenNext's
 * mature path is the edge middleware anyway. Same helper, same matcher.
 */
export async function middleware(request: NextRequest) {
  const config = supabaseConfig()
  if (!config || (await isDevAuthEnabled())) return NextResponse.next()
  return refreshSessionCookies(request, config)
}

export const config = {
  matcher: [
    // Everything except static assets and the routes that carry no session: the signed image
    // proxy, the health check, WebSub callbacks, and the OAuth callback (it writes its own
    // cookies from the code exchange).
    '/((?!_next/static|_next/image|img|api/health|api/websub|auth/callback|favicon\\.ico|.*\\.(?:png|svg|ico|txt|xml|webmanifest)$).*)',
  ],
}

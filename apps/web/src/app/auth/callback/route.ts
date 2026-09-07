import { NextResponse } from 'next/server'
import { supabaseServer } from '@/lib/auth'
import { parseAuthReturn } from '@/lib/auth-return'
import { seedReadingLangCookie } from '@/lib/reading-lang-cookie-server'

/**
 * OAuth and email-link return: make the session from what the URL carries (a PKCE code, or the
 * token hash from a sign-in email), then continue to the sanitized destination.
 */
export async function GET(request: Request) {
  const url = new URL(request.url)
  const ret = parseAuthReturn(url)
  if (ret.kind !== 'none') {
    const client = await supabaseServer()
    if (client) {
      const { data, error } =
        ret.kind === 'code'
          ? await client.auth.exchangeCodeForSession(ret.code)
          : await client.auth.verifyOtp({ type: ret.type, token_hash: ret.tokenHash })
      if (!error) {
        const response = NextResponse.redirect(new URL(ret.next, url.origin))
        if (data.user) {
          await seedReadingLangCookie(data.user.id, (name, value, options) =>
            response.cookies.set(name, value, options),
          )
        }
        return response
      }
    }
  }
  const reason = ret.kind === 'token_hash' ? 'link_failed' : 'oauth_failed'
  return NextResponse.redirect(new URL(`/login?error=${reason}`, url.origin))
}

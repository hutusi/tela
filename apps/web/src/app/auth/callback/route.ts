import { getProfile } from '@tela/db/queries'
import { isReadingLanguage } from '@tela/shared'
import { NextResponse } from 'next/server'
import { supabaseServer } from '@/lib/auth'
import { parseAuthReturn } from '@/lib/auth-return'
import { getDb } from '@/lib/platform/db'
import {
  READING_LANG_COOKIE,
  READING_LANG_COOKIE_OPTIONS,
  readingLangCookie,
} from '@/lib/reading-lang-cookie'

/**
 * Seed the reading-language cookie from the account, so the first page after signing in already
 * has it and does not pay a database round trip to read it back (see `getReadingLang`). Sign-in
 * is the one moment we know the member and are on a response that can write cookies; failing
 * here only costs that round trip, so it never blocks the sign-in.
 */
async function seedReadingLang(response: NextResponse, userId: string): Promise<void> {
  try {
    const profile = await getProfile(await getDb(), userId)
    if (!isReadingLanguage(profile?.readingLang)) return
    response.cookies.set(
      READING_LANG_COOKIE,
      readingLangCookie(userId, profile.readingLang),
      READING_LANG_COOKIE_OPTIONS,
    )
  } catch (err) {
    console.warn('[tela] could not seed the reading-language cookie', { err: String(err) })
  }
}

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
        if (data.user) await seedReadingLang(response, data.user.id)
        return response
      }
    }
  }
  const reason = ret.kind === 'token_hash' ? 'link_failed' : 'oauth_failed'
  return NextResponse.redirect(new URL(`/login?error=${reason}`, url.origin))
}

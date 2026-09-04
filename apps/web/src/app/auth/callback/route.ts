import { NextResponse } from 'next/server'
import { supabaseServer } from '@/lib/auth'

/** OAuth and magic-link return: exchange the code for a session, then continue. */
export async function GET(request: Request) {
  const url = new URL(request.url)
  const code = url.searchParams.get('code')
  const nextParam = url.searchParams.get('next') ?? '/reading'
  const next = nextParam.startsWith('/') && !nextParam.startsWith('//') ? nextParam : '/reading'
  if (code) {
    const client = await supabaseServer()
    if (client) {
      const { error } = await client.auth.exchangeCodeForSession(code)
      if (!error) return NextResponse.redirect(new URL(next, url.origin))
    }
  }
  return NextResponse.redirect(new URL('/login?error=oauth_failed', url.origin))
}

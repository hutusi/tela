'use server'

import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { supabaseServer } from '@/lib/auth'
import { isDevAuthEnabled } from '@/lib/platform/env'
import { safeNext } from '@/lib/redirect'

export type LoginState = {
  step: 'email' | 'code'
  email?: string
  error?: string | null
}

async function siteOrigin(): Promise<string> {
  const h = await headers()
  const proto = h.get('x-forwarded-proto') ?? 'https'
  const host = h.get('x-forwarded-host') ?? h.get('host') ?? 'localhost:3000'
  return `${proto}://${host}`
}

/** Step 1: send a one-time code to the email address. */
export async function sendCode(_prev: LoginState, form: FormData): Promise<LoginState> {
  const email = String(form.get('email') ?? '')
    .trim()
    .toLowerCase()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { step: 'email', error: 'invalid_email' }
  const client = await supabaseServer()
  if (!client) return { step: 'email', error: 'not_configured' }
  // Signup is closed while Tela is in private testing: an address without an account is refused
  // here rather than silently created (Supabase answers 422 once [auth] enable_signup is off).
  const { error } = await client.auth.signInWithOtp({ email, options: { shouldCreateUser: false } })
  if (error) {
    const closed =
      error.status === 422 || /signups? not allowed|signup.*disabled/i.test(error.message)
    return { step: 'email', error: closed ? 'not_invited' : 'send_failed' }
  }
  return { step: 'code', email, error: null }
}

/** Step 2: verify the code, which sets the session cookies. */
export async function verifyCode(_prev: LoginState, form: FormData): Promise<LoginState> {
  const email = String(form.get('email') ?? '')
    .trim()
    .toLowerCase()
  const token = String(form.get('code') ?? '').replace(/\s+/g, '')
  const client = await supabaseServer()
  if (!client) return { step: 'email', error: 'not_configured' }
  const { error } = await client.auth.verifyOtp({ email, token, type: 'email' })
  if (error) return { step: 'code', email, error: 'bad_code' }
  redirect(safeNext(form.get('next'), '/reading'))
}

/** OAuth: ask Supabase for the provider URL and send the browser there. */
export async function signInWithProvider(form: FormData): Promise<void> {
  const provider = String(form.get('provider') ?? '')
  if (provider !== 'github' && provider !== 'google') return
  const client = await supabaseServer()
  if (!client) redirect('/login?error=not_configured')
  const next = safeNext(form.get('next'), '/reading')
  const { data, error } = await client.auth.signInWithOAuth({
    provider,
    options: { redirectTo: `${await siteOrigin()}/auth/callback?next=${encodeURIComponent(next)}` },
  })
  if (error || !data.url) redirect('/login?error=oauth_failed')
  redirect(data.url)
}

/** Dev-auth mode: nothing to do, the session is implicit. */
export async function continueAsDevUser(form: FormData): Promise<void> {
  if (!(await isDevAuthEnabled())) redirect('/login')
  redirect(safeNext(form.get('next'), '/reading'))
}

export async function signOut(): Promise<void> {
  const client = await supabaseServer()
  if (client) await client.auth.signOut()
  redirect('/')
}

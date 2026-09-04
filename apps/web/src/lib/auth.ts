import { createServerClient } from '@supabase/ssr'
import type { SupabaseClient } from '@supabase/supabase-js'
import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { cache } from 'react'
import { isDevAuthEnabled } from './platform/env'

export type SessionUser = { id: string; email: string | null }

/** Fixed id of the local development user (created by `bun run db:local`). */
export const DEV_USER_ID = '00000000-0000-4000-8000-000000000001'

export function supabaseConfig(): { url: string; anonKey: string } | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  return url && anonKey ? { url, anonKey } : null
}

/** Supabase client bound to the request's cookies. Null when Supabase is not configured. */
export async function supabaseServer(): Promise<SupabaseClient | null> {
  const config = supabaseConfig()
  if (!config) return null
  const store = await cookies()
  return createServerClient(config.url, config.anonKey, {
    cookies: {
      getAll: () => store.getAll(),
      setAll: (list) => {
        try {
          for (const { name, value, options } of list) store.set(name, value, options)
        } catch {
          // Server Components cannot set cookies; the callback route and actions can.
        }
      },
    },
  })
}

/**
 * The signed-in user, or null. In dev-auth mode (TELA_DEV_AUTH=1, never on Cloudflare)
 * every request is the fixed development user, which lets the app and e2e tests run
 * without a Supabase project.
 */
export const getSessionUser = cache(async (): Promise<SessionUser | null> => {
  if (await isDevAuthEnabled()) {
    return { id: process.env.TELA_DEV_USER_ID ?? DEV_USER_ID, email: 'dev@tela.local' }
  }
  const client = await supabaseServer()
  if (!client) return null
  const { data } = await client.auth.getClaims()
  const sub = data?.claims?.sub
  if (typeof sub !== 'string') return null
  const email = typeof data?.claims?.email === 'string' ? data.claims.email : null
  return { id: sub, email }
})

/** Redirects to the login page when nobody is signed in. */
export async function requireUser(next?: string): Promise<SessionUser> {
  const user = await getSessionUser()
  if (!user) redirect(next ? `/login?next=${encodeURIComponent(next)}` : '/login')
  return user
}

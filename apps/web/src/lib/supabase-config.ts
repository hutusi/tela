export type SupabaseConfig = { url: string; anonKey: string }

/**
 * Supabase project URL and anon key from the public env; null when Supabase is not configured.
 * Kept free of Next server imports so the request proxy can use it.
 */
export function supabaseConfig(): SupabaseConfig | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  return url && anonKey ? { url, anonKey } : null
}

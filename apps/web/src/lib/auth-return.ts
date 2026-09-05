import { safeNext } from './redirect'

/** Email OTP types Supabase verifies with a token hash; anything else is refused before it reaches Auth. */
export const TOKEN_HASH_TYPES = [
  'email',
  'signup',
  'magiclink',
  'recovery',
  'invite',
  'email_change',
] as const
export type TokenHashType = (typeof TOKEN_HASH_TYPES)[number]

export type AuthReturn =
  | { kind: 'code'; code: string; next: string }
  | { kind: 'token_hash'; tokenHash: string; type: TokenHashType; next: string }
  | { kind: 'none'; next: string }

/**
 * What an auth return URL carries: a PKCE code (OAuth; exchanged with the verifier cookie of the
 * browser that started the flow) or a token hash from an email link (verified directly, so the
 * link works from any browser), plus the sanitized destination.
 */
export function parseAuthReturn(url: URL): AuthReturn {
  const next = safeNext(url.searchParams.get('next'), '/reading')
  const code = url.searchParams.get('code')
  if (code) return { kind: 'code', code, next }
  const tokenHash = url.searchParams.get('token_hash')
  const type = url.searchParams.get('type') ?? ''
  if (tokenHash && (TOKEN_HASH_TYPES as readonly string[]).includes(type)) {
    return { kind: 'token_hash', tokenHash, type: type as TokenHashType, next }
  }
  return { kind: 'none', next }
}

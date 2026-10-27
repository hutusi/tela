/**
 * Approved apps (ADR 0064): the statements that end connections, which every path that ends a
 * member's other sessions adds to its own batch, and the secrets and hashes tokens are made of.
 * Resolving a token, exchanging a code and rotating a refresh token build on these.
 */
import {
  ACCESS_TOKEN_PREFIX,
  type AppEndReason,
  CLIENT_ID_PREFIX,
  REFRESH_TOKEN_PREFIX,
} from '@tela/shared'
import { sql } from 'drizzle-orm'
import type { TelaDb } from '../db'

/**
 * End every live connection a member has, and each device's tokens under them, for `reason`. Two
 * statements, tokens first, for the caller's own batch: wherever Tela ends a member's other
 * sessions (password, provider link, sign out everywhere, the console's sign-out and suspension,
 * closing the account), their apps stop in the same commit.
 */
export function endConnections(db: TelaDb, userId: string, reason: AppEndReason, now: number) {
  return [
    db.run(sql`
      update app_tokens set ended_at = ${now}, end_reason = ${reason}
      where ended_at is null
        and grant_id in (select id from app_grants where user_id = ${userId} and ended_at is null)
    `),
    db.run(sql`
      update app_grants set ended_at = ${now}, end_reason = ${reason}, updated_at = ${now}
      where user_id = ${userId} and ended_at is null
    `),
  ] as const
}

/** End every live connection to one app, for everyone: the operator's "End all connections". */
export function endAppConnections(db: TelaDb, appId: number, reason: AppEndReason, now: number) {
  return [
    db.run(sql`
      update app_tokens set ended_at = ${now}, end_reason = ${reason}
      where ended_at is null
        and grant_id in (select id from app_grants where app_id = ${appId} and ended_at is null)
    `),
    db.run(sql`
      update app_grants set ended_at = ${now}, end_reason = ${reason}, updated_at = ${now}
      where app_id = ${appId} and ended_at is null
    `),
  ] as const
}

/** `bytes` random bytes as unpadded base64url. Web Crypto: workerd, Node 24 and Bun alike. */
export function randomSecret(bytes = 32): string {
  const buffer = new Uint8Array(bytes)
  crypto.getRandomValues(buffer)
  let binary = ''
  for (const b of buffer) binary += String.fromCharCode(b)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

/** A new access token, refresh token or authorization code. Shown once; only its hash is kept. */
export const newAccessToken = () => `${ACCESS_TOKEN_PREFIX}${randomSecret()}`
export const newRefreshToken = () => `${REFRESH_TOKEN_PREFIX}${randomSecret()}`
export const newAuthCode = () => randomSecret()
/** A new app's public `client_id`. */
export const newClientId = () => `${CLIENT_ID_PREFIX}${randomSecret(12)}`

/** SHA-256 of a secret, lowercase hex: what `app_tokens`, `app_refresh_spent` and `app_codes` hold. */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

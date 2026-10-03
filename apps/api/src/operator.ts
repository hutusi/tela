/**
 * The operator's routes, `/api/admin/*`: `bun run admin` calls them over the public origin with
 * `ADMIN_TOKEN`, so D1 credentials never leave Cloudflare (ADR 0024).
 */
import type { Context } from 'hono'

/** Constant-time comparison, so a wrong token takes as long as a nearly right one. */
export function sameSecret(given: string, expected: string): boolean {
  const a = new TextEncoder().encode(given)
  const b = new TextEncoder().encode(expected)
  let diff = a.length ^ b.length
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0)
  return diff === 0
}

/** Whether a request carries the operator's token. With no token set, none does. */
export function fromOperator(c: Context, token: string | undefined): boolean {
  const given = c.req.header('authorization')?.replace(/^Bearer /, '') ?? ''
  return token !== undefined && token !== '' && sameSecret(given, token)
}

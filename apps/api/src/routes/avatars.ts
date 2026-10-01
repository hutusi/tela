/**
 * A member's picture (ADR 0032), for tela-web's `/avatar/<userId>`, which caches the answer in the
 * colo: their Gravatar, fetched here so the email's hash never leaves the server and Gravatar only
 * ever sees Tela. Public, like the profiles it appears on, and only while the member shows it.
 */
import { sha256Hex } from '@tela/content/hash'
import { first, gravatarOn } from '@tela/data'
import { GRAVATAR_URL } from '@tela/shared'
import { sql } from 'drizzle-orm'
import { Hono } from 'hono'
import type { ApiEnv } from '../app'
import type { ApiDeps } from '../deps'

/** The address carries the version, so an answer never changes under it: 30 days, everywhere. */
export const AVATAR_CACHE = 'public, max-age=2592000, immutable'
const MEMBER_ID = /^[A-Za-z0-9_-]{8,64}$/
const VERSION = /^\d{1,16}$/
/** Twice the largest size a profile shows (112px), for a sharp picture on a dense screen. */
const SIZE = 256
const MAX_BYTES = 512 * 1024
const TIMEOUT_MS = 5000
// SVG can carry script; only raster types a browser renders in an <img>, as the image proxy says.
const TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

/** The body, or null past `max` bytes, without reading further than that. */
async function readAtMost(body: ReadableStream<Uint8Array>, max: number) {
  const reader = body.getReader()
  const parts: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > max) {
      await reader.cancel()
      return null
    }
    parts.push(value)
  }
  const out = new Uint8Array(size)
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.byteLength
  }
  return out
}

export function avatarRoutes(deps: ApiDeps) {
  const { db } = deps
  const base = (deps.config.gravatarUrl ?? GRAVATAR_URL).replace(/\/+$/, '')
  const routes = new Hono<ApiEnv>()
  /** No picture: the letter shows. Cached as long as the answer can be trusted to hold. */
  const none = (maxAge: number) =>
    new Response('no picture', {
      status: 404,
      headers: { 'content-type': 'text/plain', 'cache-control': `public, max-age=${maxAge}` },
    })
  const failed = () =>
    new Response('upstream failed', {
      status: 502,
      headers: { 'content-type': 'text/plain', 'cache-control': 'no-store' },
    })

  routes.get('/:userId', async (c) => {
    const userId = c.req.param('userId')
    const version = c.req.query('v') ?? ''
    if (!MEMBER_ID.test(userId) || !VERSION.test(version)) return none(300)
    // Only the version the member's picture is at: a made-up one is a 404 here, never another
    // request to Gravatar, and an old one stops answering once the member moves on. Their upload
    // comes first (ADR 0033); a Gravatar only while shown and once Gravatar said it has one: the
    // same rule as the address itself (`avatarSql`), so nothing unpublished is fetched.
    const row = await first<{ email: string; avatarKey: string | null }>(
      db,
      sql`select u.email, p.avatar_key as "avatarKey" from profiles p join "user" u on u.id = p.user_id
        where p.user_id = ${userId} and p.avatar_version = ${Number(version)}
          and (p.avatar_key is not null or (${gravatarOn('p')} and p.gravatar_found = 1))`,
    )
    if (!row) return none(300)
    if (row.avatarKey) {
      const stored = await deps.blobs.get(row.avatarKey)
      if (!stored) return none(300)
      return new Response(await stored.arrayBuffer(), {
        headers: {
          'content-type': stored.contentType ?? 'application/octet-stream',
          'cache-control': AVATAR_CACHE,
          'x-content-type-options': 'nosniff',
          'content-security-policy': "default-src 'none'; sandbox",
        },
      })
    }
    const hash = await sha256Hex(row.email.trim().toLowerCase())
    let upstream: Response
    try {
      // A host of Tela's choosing, not a member's, and `global_fetch_strictly_public` holds the
      // socket to public addresses. `d=404`: no picture is an answer, not Gravatar's placeholder.
      upstream = await fetch(`${base}/${hash}?s=${SIZE}&d=404`, {
        headers: { accept: 'image/*' },
        redirect: 'manual',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
    } catch {
      return failed()
    }
    // No Gravatar for this address: a day, and Refresh is a new address if they make one.
    if (upstream.status === 404) return none(86400)
    const type =
      (upstream.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? ''
    if (upstream.status !== 200 || !upstream.body || !TYPES.has(type)) return failed()
    if (Number(upstream.headers.get('content-length') ?? '0') > MAX_BYTES) return failed()
    // The headers can arrive and the body still break off, or outlast the timeout.
    let bytes: Uint8Array<ArrayBuffer> | null
    try {
      bytes = await readAtMost(upstream.body, MAX_BYTES)
    } catch {
      return failed()
    }
    if (!bytes) return failed()
    return new Response(bytes, {
      headers: {
        'content-type': type,
        'cache-control': AVATAR_CACHE,
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; sandbox",
      },
    })
  })
  return routes
}

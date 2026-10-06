/**
 * A blogger claiming their blog (ADR 0011, 0018): prove it with a meta tag carrying a token, or a
 * rel="me" link back to their Tela profile, then ask for the check.
 *
 * The token is derived, not stored: an HMAC of the site and member under the server's secret. So
 * nothing exists until the member asks for the check, and a `pending` claim is always one they
 * asked for: the verify sweep claims `pending` rows, and a row made at "start" would be checked
 * before the token could be on the page.
 */
import { bumpSeq, claimDue, consumeLimit, currentSeq, dueClaims, first } from '@tela/data'
import { sql } from 'drizzle-orm'
import { Hono } from 'hono'
import type { ApiEnv } from '../app'
import type { ApiDeps } from '../deps'

const CLAIM_TTL_MS = 4 * 60_000
const META_NAME = 'tela-site-verification'

/**
 * Claim one pending claim's check and send it on, so the member (or an operator re-checking or
 * vouching for it) sees the answer in seconds rather than at the next sweep. Nothing is sent when
 * the claim is not pending or a check of it is already held; the sweep finds it then.
 */
export async function checkClaimSoon(
  deps: Pick<ApiDeps, 'db' | 'jobs'>,
  claimId: number,
  now: number,
) {
  const owner = `site.claim:api:${now.toString(36)}`
  const claimed = await claimDue(deps.db, {
    kind: 'site.claim',
    owner,
    now,
    ttlMs: CLAIM_TTL_MS,
    limit: 1,
    due: sql`select * from (${dueClaims()}) where key = ${claimId}`,
  })
  if (claimed.length > 0) {
    await deps.jobs.send('misc', { kind: 'site.claim', key: String(claimId), owner })
  }
}

export async function claimToken(secret: string, siteId: number, userId: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const mac = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`claim:${siteId}:${userId}`),
  )
  return [...new Uint8Array(mac).slice(0, 12)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export function claimRoutes(deps: ApiDeps) {
  const { db, config } = deps
  const routes = new Hono<ApiEnv>()

  /** Where a member stands with a site: whose it is, and how to prove it is theirs. */
  const standing = async (siteId: number, userId: string) => {
    const site = await first<{ id: number; home_url: string; claimed_by: string | null }>(
      db,
      sql`select id, home_url, claimed_by from sites where id = ${siteId}`,
    )
    if (!site) return null
    if (site.claimed_by === userId)
      return { siteId, homeUrl: site.home_url, status: 'verified' as const }
    if (site.claimed_by)
      return { siteId, homeUrl: site.home_url, status: 'claimed_by_other' as const }
    const token = await claimToken(config.authSecret, siteId, userId)
    const profile = await first<{ handle: string }>(
      db,
      sql`select handle from profiles where user_id = ${userId}`,
    )
    const claim = await first<{ id: number; status: string; error: string | null }>(
      db,
      sql`select id, status, error from site_claims where site_id = ${siteId} and user_id = ${userId}`,
    )
    return {
      siteId,
      homeUrl: site.home_url,
      status: (claim?.status ?? 'unverified') as 'unverified' | 'pending' | 'failed',
      error: claim?.error ?? null,
      proofs: {
        meta: `<meta name="${META_NAME}" content="${token}">`,
        relMe: `<link rel="me" href="${config.publicUrl}/@${profile?.handle ?? ''}">`,
      },
    }
  }

  routes.post('/', async (c) => {
    const member = c.get('member')
    const body = (await c.req.json().catch(() => ({}))) as { url?: unknown }
    if (typeof body.url !== 'string') return c.json({ error: 'invalid_url' }, 400)
    if (!(await consumeLimit(db, 'claimStart', member.id, deps.clock.now())).allowed) {
      return c.json({ error: 'rate_limited' }, 429)
    }
    const started = await deps.ingest.startClaim({ url: body.url, actorId: member.id })
    if ('error' in started) return c.json(started, started.error === 'invalid_url' ? 400 : 422)
    return c.json(await standing(started.siteId, member.id))
  })

  routes.get('/:siteId', async (c) => {
    const siteId = Number(c.req.param('siteId'))
    if (!Number.isInteger(siteId)) return c.json({ error: 'not_found' }, 404)
    const state = await standing(siteId, c.get('member').id)
    return state ? c.json(state) : c.json({ error: 'not_found' }, 404)
  })

  routes.post('/:siteId/verify', async (c) => {
    const member = c.get('member')
    const siteId = Number(c.req.param('siteId'))
    if (!Number.isInteger(siteId)) return c.json({ error: 'not_found' }, 404)
    const state = await standing(siteId, member.id)
    if (!state) return c.json({ error: 'not_found' }, 404)
    if (state.status === 'verified' || state.status === 'claimed_by_other') return c.json(state)
    const now = deps.clock.now()
    if (!(await consumeLimit(db, 'claimVerify', member.id, now)).allowed) {
      return c.json({ error: 'rate_limited' }, 429)
    }
    const token = await claimToken(config.authSecret, siteId, member.id)
    // A member asking again clears an operator's vouch (ADR 0039): the check they asked for is
    // the one that reads their proof.
    const [, rows] = (await db.batch([
      bumpSeq(db),
      db.all(sql`
        insert into site_claims (site_id, user_id, method, token, status, created_at, seq)
        values (${siteId}, ${member.id}, 'meta', ${token}, 'pending', ${now}, ${currentSeq})
        on conflict (site_id, user_id) do update set
          token = excluded.token, status = 'pending', error = null, vouched_by = null,
          seq = excluded.seq
        where site_claims.status <> 'verified'
        returning id
      `),
    ] as never)) as unknown as [unknown, { id: number }[]]
    const claimId = rows[0]?.id
    if (claimId !== undefined) await checkClaimSoon(deps, claimId, now)
    return c.json(await standing(siteId, member.id))
  })

  return routes
}

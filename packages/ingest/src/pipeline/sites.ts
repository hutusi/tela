/**
 * The site-level jobs: favicons, claim verification, and WebSub subscriptions. Each runs under a
 * lease whose host is the site's, so a site is fetched politely and two claims on one site cannot
 * race each other (ADR 0021).
 */
import { absoluteUrl, findFeedLinks } from '@tela/content'
import {
  bumpSeq,
  currentSeq,
  feedIsVouched,
  feedOrigin,
  first,
  type Lease,
  moveFeedToOrigin,
  type TelaDb,
} from '@tela/data'
import type { ClaimMethod } from '@tela/shared'
import { findAll, getAttributeValue } from 'domutils'
import { type SQL, sql } from 'drizzle-orm'
import { parseDocument } from 'htmlparser2'
import { type HttpClient, HttpError } from '../http'
import { requestHubSubscription } from '../websub'
import { commit, type IngestContext, type Statement } from './context'

/** The host of a site's origin (`https://blog.example` → `blog.example`), in SQL. */
const siteHost = (homeUrl: SQL) => sql`substr(${homeUrl}, instr(${homeUrl}, '://') + 3)`

// ---------------------------------------------------------------------------------------------
// Favicons

const MAX_ICON_BYTES = 256 * 1024
/** Stored as served: raster types a browser renders in an <img>. No SVG: it can carry script. */
const ICON_TYPES = new Map([
  ['image/x-icon', 'ico'],
  ['image/vnd.microsoft.icon', 'ico'],
  ['image/png', 'png'],
  ['image/jpeg', 'jpg'],
  ['image/gif', 'gif'],
  ['image/webp', 'webp'],
])

/** Candidate icon URLs from a page, best first (declared size, apple-touch, then /favicon.ico). */
export function findIconUrls(html: string, baseUrl: string): string[] {
  const doc = parseDocument(html)
  const scored: Array<{ url: string; score: number }> = []
  for (const link of findAll((el) => el.name === 'link', doc.children)) {
    const rel = (getAttributeValue(link, 'rel') ?? '').toLowerCase().split(/\s+/)
    if (!rel.some((r) => r === 'icon' || r.startsWith('apple-touch-icon'))) continue
    const url = absoluteUrl(getAttributeValue(link, 'href') ?? '', baseUrl)
    if (!url || /\.svg(\?|$)/i.test(url)) continue
    const px = Number((getAttributeValue(link, 'sizes') ?? '').match(/(\d+)x/i)?.[1] ?? 0)
    const apple = rel.some((r) => r.startsWith('apple')) ? 1000 : 0
    scored.push({ url, score: (px >= 32 && px <= 512 ? px : 0) + apple })
  }
  scored.sort((a, b) => b.score - a.score)
  const urls = [...new Set(scored.map((s) => s.url))]
  const fallback = absoluteUrl('/favicon.ico', baseUrl)
  if (fallback && !urls.includes(fallback)) urls.push(fallback)
  return urls
}

/** Sites whose favicon has never been looked for. */
export const dueAssets = (): SQL =>
  sql`select id as key, ${siteHost(sql`home_url`)} as host, created_at as ord
      from sites where assets_checked_at is null`

async function tryGet(http: HttpClient, url: string, accept: string) {
  try {
    return await http.get(url, { accept, region: 'global' })
  } catch (err) {
    if (err instanceof HttpError) return null
    throw err
  }
}

/** Find and store a site's favicon. The stamp is written whatever happens, so it runs once. */
export async function siteAssetsJob(
  ctx: IngestContext,
  lease: Lease,
): Promise<{ status: 'done' | 'skipped' | 'lost'; favicon?: boolean }> {
  const siteId = Number(lease.key)
  const site = await first<{ home_url: string }>(
    ctx.db,
    sql`select home_url from sites where id = ${siteId} and assets_checked_at is null`,
  )
  if (!site || !ctx.assets) {
    const committed = await commit(ctx, lease, [])
    return committed.ok ? { status: 'skipped' } : { status: 'lost' }
  }
  const page = await tryGet(ctx.http, site.home_url, 'text/html, */*;q=0.5')
  const html = page?.status === 200 ? page.body : ''
  const base = page?.status === 200 ? page.finalUrl : site.home_url
  let faviconKey: string | null = null
  for (const url of findIconUrls(html, base)) {
    const icon = await tryGet(ctx.http, url, 'image/*,*/*;q=0.5')
    if (icon?.status !== 200 || icon.bytes === 0 || icon.bytes > MAX_ICON_BYTES) continue
    const type = (icon.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? ''
    const ext = ICON_TYPES.get(type)
    if (!ext) continue
    faviconKey = `sites/${siteId}/favicon-${ctx.clock.now().toString(36)}.${ext}`
    await ctx.assets.put(faviconKey, icon.raw, {
      contentType: type,
      cacheControl: 'public, max-age=31536000, immutable',
    })
    break
  }
  const now = ctx.clock.now()
  const committed = await commit(ctx, lease, [
    ctx.db.run(sql`
      update sites set assets_checked_at = ${now}, favicon_key = coalesce(${faviconKey}, favicon_key),
        updated_at = ${now}, seq = ${currentSeq}
      where id = ${siteId}
    `),
  ])
  return committed.ok ? { status: 'done', favicon: faviconKey !== null } : { status: 'lost' }
}

// ---------------------------------------------------------------------------------------------
// Claim verification (ADR 0011)

export const VERIFICATION_META = 'tela-site-verification'
/** Declared feeds kept per site, and the time budget for learning where they redirect. */
export const MAX_DECLARED_FEEDS = 20
const DECLARED_FEED_TIMEOUT_MS = 5000
const DECLARED_FEEDS_BUDGET_MS = 90_000

/** Does the page carry the token in a meta tag, or a rel="me" link to the member's profile? */
export function findProof(
  html: string,
  token: string,
  profileUrls: string[],
): { method: 'meta' | 'rel_me' } | null {
  const doc = parseDocument(html)
  for (const meta of findAll((el) => el.name === 'meta', doc.children)) {
    if (
      (getAttributeValue(meta, 'name') ?? '').toLowerCase() === VERIFICATION_META &&
      (getAttributeValue(meta, 'content') ?? '').trim() === token
    ) {
      return { method: 'meta' }
    }
  }
  const targets = new Set(profileUrls.map((u) => u.replace(/\/+$/, '').toLowerCase()))
  for (const el of findAll((el) => el.name === 'link' || el.name === 'a', doc.children)) {
    const rel = (getAttributeValue(el, 'rel') ?? '').toLowerCase().split(/\s+/)
    const href = (getAttributeValue(el, 'href') ?? '').trim().replace(/\/+$/, '').toLowerCase()
    if (rel.includes('me') && targets.has(href)) return { method: 'rel_me' }
  }
  return null
}

/** The declared feed URLs kept, plus where each redirects to, under one time budget. */
export async function resolveDeclaredFeeds(
  http: Pick<HttpClient, 'get'>,
  urls: string[],
  clock: () => number,
): Promise<string[]> {
  const kept = urls.slice(0, MAX_DECLARED_FEEDS)
  const out = new Set<string>(kept)
  const deadline = clock() + DECLARED_FEEDS_BUDGET_MS
  for (const url of kept) {
    const remaining = deadline - clock()
    if (remaining <= 0) break
    try {
      const res = await http.get(url, {
        region: 'global',
        accept: 'application/rss+xml, application/atom+xml, application/feed+json, */*;q=0.5',
        timeoutMs: Math.min(DECLARED_FEED_TIMEOUT_MS, remaining),
      })
      if (res.status === 200 && res.finalUrl !== url) out.add(res.finalUrl)
    } catch (err) {
      if (!(err instanceof HttpError)) throw err
    }
  }
  return [...out]
}

/** Claims a member asked to verify (in `@tela/data`, so tela-api can claim one at once). */
export { dueClaims } from '@tela/data'

export type ClaimOutcome =
  | { status: 'verified'; method: ClaimMethod; vouched: boolean; detached: number }
  | { status: 'failed'; error: string }
  | { status: 'skipped'; reason: string }
  | { status: 'lost' }

function claimFailed(db: TelaDb, claimId: number, error: string, now: number) {
  return db.run(sql`
    update site_claims set status = 'failed', error = ${error.slice(0, 500)}, last_checked_at = ${now},
      seq = ${currentSeq}
    where id = ${claimId}
  `)
}

/**
 * Fetch the site's home page and settle the pending claim. A claim an operator vouched for (ADR
 * 0039) skips only the proof: the page is still fetched, because the feeds it declares are the
 * ones the site will vouch for, and a site another member holds is still not taken from them.
 */
export async function verifyClaimJob(ctx: IngestContext, lease: Lease): Promise<ClaimOutcome> {
  const { db } = ctx
  const claimId = Number(lease.key)
  const claim = await first<{
    site_id: number
    user_id: string
    token: string
    method: ClaimMethod
    status: string
    vouched_by: string | null
    home_url: string
    claimed_by: string | null
    handle: string | null
  }>(
    db,
    sql`
      select c.site_id, c.user_id, c.token, c.method, c.status, c.vouched_by, s.home_url,
        s.claimed_by, p.handle
      from site_claims c join sites s on s.id = c.site_id
      left join profiles p on p.user_id = c.user_id
      where c.id = ${claimId}
    `,
  )
  const done = async (statements: Statement[], outcome: ClaimOutcome): Promise<ClaimOutcome> => {
    const committed = await commit(ctx, lease, statements)
    return committed.ok ? outcome : { status: 'lost' }
  }
  if (claim?.status !== 'pending') {
    return done([], { status: 'skipped', reason: 'claim is not pending' })
  }
  const fail = (error: string) =>
    done([claimFailed(db, claimId, error, ctx.clock.now())], { status: 'failed', error })
  if (!claim.handle) return fail('the claimant has no profile')
  if (claim.claimed_by !== null && claim.claimed_by !== claim.user_id) {
    return fail('site already claimed by another member')
  }

  let page: Awaited<ReturnType<HttpClient['get']>>
  try {
    page = await ctx.http.get(claim.home_url, {
      region: 'global',
      accept: 'text/html, application/xhtml+xml, */*;q=0.5',
    })
  } catch (err) {
    const why = err instanceof HttpError ? `${err.kind}: ${err.message}` : String(err)
    return fail(`could not fetch ${claim.home_url} (${why})`)
  }
  if (page.status !== 200 || !page.body) return fail(`home page returned HTTP ${page.status}`)
  const base = (ctx.publicUrl ?? 'https://tela.ainaive.com').replace(/\/+$/, '')
  const vouched = claim.vouched_by !== null
  const proof = vouched
    ? { method: claim.method }
    : findProof(page.body, claim.token, [`${base}/@${claim.handle}`])
  if (!proof) {
    return fail(
      `no <meta name="${VERIFICATION_META}"> with the token and no rel="me" link to your profile on ${page.finalUrl}`,
    )
  }

  // The feeds the home page declares are the ones the owner vouches for; every other feed that
  // joined while the site was unclaimed moves to the origin that serves it.
  const declared = await resolveDeclaredFeeds(
    ctx.http,
    findFeedLinks(page.body, page.finalUrl)
      .filter((c) => c.source === 'link')
      .map((c) => c.url),
    () => ctx.clock.now(),
  )
  const now = ctx.clock.now()
  const site = { homeUrl: claim.home_url, claimedBy: claim.user_id, declaredFeedUrls: declared }
  const feeds = await db.all<{
    id: number
    feed_url: string
    served_origin: string | null
    added_by: string | null
  }>(sql`select id, feed_url, served_origin, added_by from feeds where site_id = ${claim.site_id}`)
  const moves: Statement[] = []
  for (const f of feeds) {
    const feed = { feedUrl: f.feed_url, servedOrigin: f.served_origin, addedBy: f.added_by }
    if (feedIsVouched(feed, site)) continue
    const origin = feedOrigin(feed)
    if (origin && origin !== claim.home_url) {
      moves.push(...moveFeedToOrigin(db, { id: f.id, siteId: claim.site_id }, origin, now))
    }
  }
  return done(
    [
      db.run(sql`
        update site_claims set status = 'verified', method = ${proof.method}, error = null,
          last_checked_at = ${now}, verified_at = ${now}, seq = ${currentSeq}
        where id = ${claimId}
      `),
      db.run(sql`
        update sites set claimed_by = ${claim.user_id}, claimed_at = ${now},
          listing = case when listing = 'private' then 'listed' else listing end,
          declared_feed_urls = ${JSON.stringify(declared)}, updated_at = ${now}, seq = ${currentSeq}
        where id = ${claim.site_id} and (claimed_by is null or claimed_by = ${claim.user_id})
      `),
      ...moves,
    ],
    {
      status: 'verified',
      method: proof.method,
      vouched,
      detached: moves.length > 0 ? feeds.length : 0,
    },
  )
}

// ---------------------------------------------------------------------------------------------
// WebSub (the subscriber side; the hub's callback lands on the web app)

export const WEBSUB_RENEW_BEFORE_MS = 2 * 24 * 3600 * 1000
export const WEBSUB_PENDING_RETRY_MS = 24 * 3600 * 1000
export const WEBSUB_FAILED_RETRY_MS = 7 * 24 * 3600 * 1000

/** Subscriptions to request: new, pending too long, failed a week ago, or ending within two days. */
export const dueWebsub = (now: number): SQL =>
  sql`select w.feed_id as key, null as host, coalesce(w.requested_at, 0) as ord
      from websub_subscriptions w join feeds f on f.id = w.feed_id
      where f.status = 'active' and f.hub_url is not null and (
        (w.status = 'pending' and (w.requested_at is null or w.requested_at < ${now - WEBSUB_PENDING_RETRY_MS}))
        or (w.status = 'failed' and w.updated_at < ${now - WEBSUB_FAILED_RETRY_MS})
        or (w.status = 'active' and (w.lease_until is null or w.lease_until < ${now + WEBSUB_RENEW_BEFORE_MS}))
      )`

/** Ask a feed's hub to push to the web app's callback. The secret survives renewals. */
export async function websubSubscribeJob(
  ctx: IngestContext,
  lease: Lease,
  fetchImpl?: typeof fetch,
): Promise<{ status: 'requested' | 'failed' | 'skipped' | 'lost'; error?: string }> {
  const feedId = Number(lease.key)
  const row = await first<{ hub_url: string; feed_url: string; secret: string }>(
    ctx.db,
    sql`select f.hub_url, f.feed_url, w.secret from websub_subscriptions w join feeds f on f.id = w.feed_id
        where w.feed_id = ${feedId} and f.hub_url is not null`,
  )
  if (!row || !ctx.publicUrl) {
    const committed = await commit(ctx, lease, [])
    return committed.ok ? { status: 'skipped' } : { status: 'lost' }
  }
  const now = ctx.clock.now()
  // Pending before the request: the hub's verification GET may arrive within milliseconds.
  await ctx.db.batch([
    bumpSeq(ctx.db),
    ctx.db.run(sql`
      update websub_subscriptions set status = 'pending', hub_url = ${row.hub_url},
        topic_url = ${row.feed_url}, requested_at = ${now}, updated_at = ${now}
      where feed_id = ${feedId}
    `),
  ])
  const result = await requestHubSubscription({
    hubUrl: row.hub_url,
    topicUrl: row.feed_url,
    callbackUrl: new URL(`/api/websub/${feedId}`, ctx.publicUrl).toString(),
    secret: row.secret,
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
    ...(ctx.allowPrivateHosts ? { allowPrivateHosts: true } : {}),
  })
  const statements: Statement[] = result.ok
    ? []
    : [
        ctx.db.run(sql`
          update websub_subscriptions set status = 'failed', last_error = ${result.error.slice(0, 500)},
            updated_at = ${ctx.clock.now()}
          where feed_id = ${feedId}
        `),
      ]
  const committed = await commit(ctx, lease, statements)
  if (!committed.ok) return { status: 'lost' }
  return result.ok ? { status: 'requested' } : { status: 'failed', error: result.error }
}

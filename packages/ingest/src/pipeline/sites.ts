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
import type { ClaimMethod, ClaimReason } from '@tela/shared'
import { findAll, getAttributeValue } from 'domutils'
import { type SQL, sql } from 'drizzle-orm'
import { parseDocument } from 'htmlparser2'
import { GitHubUnavailable, type GitHubUser } from '../github'
import { type HttpClient, HttpError } from '../http'
import { requestHubSubscription } from '../websub'
import { commit, type IngestContext, type Statement } from './context'
import { namesSite, type ProfileLink, profileHosts, readProofs } from './proofs'

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
// Claim verification (ADRs 0011, 0045)

/** Declared feeds kept per site, and the time budget for learning where they redirect. */
export const MAX_DECLARED_FEEDS = 20
const DECLARED_FEED_TIMEOUT_MS = 5000
const DECLARED_FEEDS_BUDGET_MS = 90_000
/** Older posts tried for a link without `rel="me"`, in case the oldest has gone. */
const SECOND_PAGE_TRIES = 2
/** A URL kept in a stored reason; the column holds 500 characters. */
const REASON_URL_MAX = 180

const HTML_ACCEPT = 'text/html, application/xhtml+xml, */*;q=0.5'

/**
 * A page that repeats what the home page shows on every page (its header, footer and sidebar)
 * but not its posts: the oldest post Tela holds on the blog's own origin. A link found on both is
 * the blog's own, not a mention in a post the home page happens to show in full (ADR 0045).
 */
async function secondPage(
  ctx: IngestContext,
  siteId: number,
  homeUrl: string,
  home: string,
): Promise<{ url: string; body: string } | null> {
  const origin = new URL(homeUrl)
  const bare = origin.hostname.replace(/^www\./, '')
  const rows = await ctx.db.all<{ url: string }>(sql`
    select a.url from articles a join feeds f on f.id = a.feed_id
    where f.site_id = ${siteId} and a.url is not null and a.url_host in (${bare}, ${`www.${bare}`})
    order by a.published_at is null, a.published_at, a.id
    limit 10
  `)
  const own = (url: string) => {
    try {
      const u = new URL(url)
      return (
        u.hostname.replace(/^www\./, '') === bare && u.port === origin.port && u.pathname !== '/'
      )
    } catch {
      return false
    }
  }
  let tried = 0
  for (const { url } of rows) {
    if (!own(url) || url === home) continue
    if (tried++ >= SECOND_PAGE_TRIES) break
    try {
      const res = await ctx.http.get(url, { region: 'global', accept: HTML_ACCEPT })
      // A post that is gone and sends readers home is the home page again, not a second page.
      if (res.status === 200 && res.body && res.finalUrl !== home && own(res.finalUrl)) {
        return { url: res.finalUrl, body: res.body }
      }
    } catch (err) {
      if (!(err instanceof HttpError)) throw err
    }
  }
  return null
}

/** The numeric id of the member's GitHub, the one thing a GitHub sign-in leaves (ADR 0036). */
async function githubIdOf(db: TelaDb, userId: string): Promise<string | null> {
  const row = await first<{ account_id: string }>(
    db,
    sql`select account_id from account where user_id = ${userId} and provider_id = 'github' limit 1`,
  )
  return row?.account_id ?? null
}

const clip = (url: string) => url.slice(0, REASON_URL_MAX)

/**
 * Which proof the home page (and, for a link without `rel="me"`, an older post) gives, or why
 * there is none, closest miss first: the member is told what to change, not what is missing.
 */
async function proofOf(
  ctx: IngestContext,
  claim: { site_id: number; user_id: string; token: string; home_url: string; handle: string },
  page: { finalUrl: string; body: string },
): Promise<{ method: ClaimMethod } | { reason: ClaimReason }> {
  const telaHosts = profileHosts(ctx.publicUrl ?? 'https://telaread.com')
  const home = readProofs(page.body, page.finalUrl, claim.token, telaHosts)
  if (home.meta) return { method: 'meta' }
  const handle = claim.handle.toLowerCase()
  const mine = (l: ProfileLink) => l.name === handle
  if (home.profiles.some((l) => mine(l) && l.me)) return { method: 'rel_me' }

  let gh: GitHubUser | null = null
  let githubDown = false
  const githubId = ctx.github ? await githubIdOf(ctx.db, claim.user_id) : null
  if (ctx.github && githubId) {
    try {
      gh = await ctx.github.user(githubId)
    } catch (err) {
      if (!(err instanceof GitHubUnavailable)) throw err
      githubDown = true
    }
  }
  const login = gh?.login.toLowerCase()
  const theirs = (l: ProfileLink) => l.name === login
  const namesThisSite = gh !== null && namesSite(gh.website, claim.home_url)
  if (namesThisSite && home.github.some((l) => theirs(l) && l.me)) return { method: 'github' }

  // A link without rel="me" is the blog's own only if every page carries it.
  const plainProfile = home.profiles.some((l) => mine(l) && !l.marked)
  const plainGithub = namesThisSite && home.github.some((l) => theirs(l) && !l.marked)
  if (plainProfile || plainGithub) {
    const target = plainProfile ? 'profile' : 'github'
    const second = await secondPage(ctx, claim.site_id, claim.home_url, page.finalUrl)
    if (!second) return { reason: { reason: 'no_second_page', page: clip(page.finalUrl), target } }
    const again = readProofs(second.body, second.url, claim.token, telaHosts)
    if (plainProfile && again.profiles.some((l) => mine(l) && !l.marked)) return { method: 'link' }
    if (plainGithub && again.github.some((l) => theirs(l) && !l.marked)) return { method: 'github' }
    return {
      reason: {
        reason: 'not_site_wide',
        page: clip(page.finalUrl),
        other: clip(second.url),
        target,
      },
    }
  }

  const markedProfile = home.profiles.find((l) => mine(l) && l.marked)
  if (markedProfile?.marked) {
    return {
      reason: {
        reason: 'link_marked',
        page: clip(page.finalUrl),
        target: 'profile',
        rel: markedProfile.marked,
      },
    }
  }
  if (gh && namesThisSite) {
    const marked = home.github.find((l) => theirs(l) && l.marked)
    return {
      reason: marked?.marked
        ? { reason: 'link_marked', page: clip(page.finalUrl), target: 'github', rel: marked.marked }
        : { reason: 'github_link', page: clip(page.finalUrl), login: gh.login },
    }
  }
  if (gh && home.github.some(theirs)) {
    return { reason: { reason: 'github_website', login: gh.login, website: clip(gh.website) } }
  }
  const another = home.profiles.find((l) => !mine(l))
  if (another) {
    return {
      reason: { reason: 'other_handle', page: clip(page.finalUrl), found: another.name, handle },
    }
  }
  if (githubDown) return { reason: { reason: 'github_unavailable' } }
  return { reason: { reason: 'no_proof', page: clip(page.finalUrl) } }
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

/** Why a claim on a blog another member holds fails. */
const TAKEN = 'site already claimed by another member'

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
  if (claim.claimed_by !== null && claim.claimed_by !== claim.user_id) return fail(TAKEN)

  let page: Awaited<ReturnType<HttpClient['get']>>
  try {
    page = await ctx.http.get(claim.home_url, { region: 'global', accept: HTML_ACCEPT })
  } catch (err) {
    const why = err instanceof HttpError ? `${err.kind}: ${err.message}` : String(err)
    return fail(`could not fetch ${claim.home_url} (${why})`)
  }
  if (page.status !== 200 || !page.body) return fail(`home page returned HTTP ${page.status}`)
  const vouched = claim.vouched_by !== null
  const found = vouched
    ? { method: claim.method }
    : await proofOf(ctx, { ...claim, handle: claim.handle }, page)
  if ('reason' in found) return fail(JSON.stringify(found.reason))
  const proof = found

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
  // Another member's claim on this blog may have been verified while this one read the page. Then
  // nothing here may be written, not the claim's "verified" nor the moves this page decided: the
  // guard aborts the batch as a lost lease's fence does, and the claim fails on its own below.
  const taken = sql`exists (select 1 from sites where id = ${claim.site_id}
    and claimed_by is not null and claimed_by <> ${claim.user_id})`
  const committed = await commit(ctx, lease, [
    db.run(sql`insert into lease_fence (x) select null where ${taken}`),
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
  ])
  if (committed.ok) {
    return {
      status: 'verified',
      method: proof.method,
      vouched,
      detached: moves.length > 0 ? feeds.length : 0,
    }
  }
  // Refused: the blog went to someone else, or the lease did. The failure's own commit is fenced,
  // so a holder that lost its lease writes nothing either way.
  if (await first(db, sql`select 1 as taken where ${taken}`)) return fail(TAKEN)
  return { status: 'lost' }
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

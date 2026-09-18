import { findFeedLinks } from '@tela/content'
import { type Db, profiles, sites } from '@tela/db'
import { getClaim, markClaimResult } from '@tela/db/queries'
import { type HttpClient, HttpError } from '@tela/ingest'
import { findAll, getAttributeValue } from 'domutils'
import { eq } from 'drizzle-orm'
import { parseDocument } from 'htmlparser2'

export const VERIFICATION_META = 'tela-site-verification'

export type VerifyDeps = {
  db: Db
  http: HttpClient
  /** Public origin of this Tela deployment, for rel="me" links (https://tela.ainaive.com). */
  publicUrl: string
}

export type VerifyOutcome =
  | { status: 'verified'; method: 'meta' | 'rel_me' }
  | { status: 'failed'; error: string }
  | { status: 'skipped'; reason: string }

/** Pure check: does the page carry the token in a meta tag, or a rel="me" link to the profile? */
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

/**
 * Declarations kept per site, in page order. A page can carry thousands of alternate links,
 * and the site row plus every provenance check would grow with it; the rest are dropped, and
 * the claim is not refused for it.
 */
export const MAX_DECLARED_FEEDS = 20
/** Per declared link, to learn where it redirects. */
export const DECLARED_FEED_TIMEOUT_MS = 5000
/** For all the lookups together; with the home page fetch this fits the claim job's expiry. */
export const DECLARED_FEEDS_BUDGET_MS = 90_000

/**
 * The declared feed URLs kept, plus the URL each redirects to when it does, learned under one
 * time budget: a slow site may leave the later ones unresolved. Unreachable or unresolved ones
 * stay as declared; the page vouched for them either way.
 */
export async function resolveDeclaredFeeds(
  http: Pick<HttpClient, 'get'>,
  urls: string[],
  clock: () => number = Date.now,
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

/** Fetch the site's home page and verify the pending claim. */
export async function verifyClaim(deps: VerifyDeps, claimId: number): Promise<VerifyOutcome> {
  const claim = await getClaim(deps.db, claimId)
  if (!claim) return { status: 'skipped', reason: 'claim not found' }
  if (claim.status === 'verified') return { status: 'skipped', reason: 'already verified' }
  const [site] = await deps.db.select().from(sites).where(eq(sites.id, claim.siteId))
  const [profile] = await deps.db
    .select({ handle: profiles.handle })
    .from(profiles)
    .where(eq(profiles.id, claim.userId))
  if (!site || !profile) return { status: 'skipped', reason: 'site or profile missing' }

  let page: Awaited<ReturnType<HttpClient['get']>>
  try {
    page = await deps.http.get(site.homeUrl, {
      region: 'global',
      accept: 'text/html, application/xhtml+xml, */*;q=0.5',
    })
  } catch (err) {
    const error = err instanceof HttpError ? `${err.kind}: ${err.message}` : String(err)
    await markClaimResult(deps.db, claimId, {
      ok: false,
      error: `could not fetch ${site.homeUrl} (${error})`,
    })
    return { status: 'failed', error }
  }
  if (page.status !== 200 || !page.body) {
    const error = `home page returned HTTP ${page.status}`
    await markClaimResult(deps.db, claimId, { ok: false, error })
    return { status: 'failed', error }
  }
  const base = deps.publicUrl.replace(/\/+$/, '')
  const proof = findProof(page.body, claim.token, [
    `${base}/@${profile.handle}`,
    `${base}/u/${profile.handle}`,
  ])
  if (!proof) {
    const error = `no <meta name="${VERIFICATION_META}"> with the token and no rel="me" link to your profile on ${page.finalUrl}`
    await markClaimResult(deps.db, claimId, { ok: false, error })
    return { status: 'failed', error }
  }
  // The feeds the home page itself declares are the ones the owner vouches for; anything else
  // that attached to the site while it was unclaimed is moved off it. A declared link often
  // redirects to where the feed is really served (FeedBurner, a CDN), and discovery stores that
  // final URL, so both are recorded.
  const declaredFeedUrls = await resolveDeclaredFeeds(
    deps.http,
    findFeedLinks(page.body, page.finalUrl)
      .filter((c) => c.source === 'link')
      .map((c) => c.url),
  )
  const outcome = await markClaimResult(deps.db, claimId, {
    ok: true,
    method: proof.method,
    declaredFeedUrls,
  })
  if (outcome === 'conflict') {
    return { status: 'failed', error: 'site already claimed by another member' }
  }
  if (outcome !== 'verified') return { status: 'skipped', reason: `claim ${outcome}` }
  return { status: 'verified', method: proof.method }
}

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
  /** Public origin of this Tela deployment, for rel="me" links (https://tela.app). */
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
  const outcome = await markClaimResult(deps.db, claimId, { ok: true, method: proof.method })
  if (outcome === 'conflict') {
    return { status: 'failed', error: 'site already claimed by another member' }
  }
  if (outcome !== 'verified') return { status: 'skipped', reason: `claim ${outcome}` }
  return { status: 'verified', method: proof.method }
}

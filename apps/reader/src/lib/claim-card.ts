/**
 * The card For writers makes, carried through signing in (the sheet's claim mode): the handle and
 * name the visitor typed become the new member's, and they go on to claim the blog they gave.
 *
 * Only a member whose handle is still the provisional one an account starts with (`u_` and ten
 * hex digits) is given it: a member who logs in through the form keeps the handle they chose.
 * While signing in leaves the page (Google or GitHub), or cannot yet say as whom (/me unreachable),
 * the card waits in this tab's sessionStorage, and the app finishes it once the session is the
 * member's (`FrontDoorProvider`), or the sheet reopens with it after a refusal.
 */
import { api } from '../store/api'

export type CardClaim = {
  /** The handle the card showed; empty when no handle could be suggested. */
  handle: string
  /** The name the visitor typed, for the profile's display name. */
  name: string
  /** The blog's address, as `/claim?url=` starts from it. */
  url: string
}

/** An account's first handle, until its member picks one (apps/api `provisionalHandle`). */
const PROVISIONAL = /^u_[0-9a-f]{10}$/

export const isProvisional = (handle: string | null | undefined) =>
  typeof handle === 'string' && PROVISIONAL.test(handle)

/** Where a card goes on to: claiming its blog, saying so when the handle is someone else's. */
export function claimPath(url: string, taken = false): string {
  const params = new URLSearchParams()
  if (url) params.set('url', url)
  if (taken) params.set('taken', '1')
  const query = params.toString()
  return query ? `/claim?${query}` : '/claim'
}

const KEY = 'tela.claim'
/** A card left this long (a provider abandoned, a tab left open) is no longer what they meant. */
const KEEP_FOR = 60 * 60 * 1000

/** Keep the card for this tab, past a page the sign-in leaves. */
export function keepClaim(claim: CardClaim): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify({ ...claim, at: Date.now() }))
  } catch {
    // No sessionStorage: signing in still works, and the card is made in Settings instead.
  }
}

/** The card this tab kept, once: reading it forgets it, so only one place finishes it. */
export function takeClaim(now = Date.now()): CardClaim | null {
  try {
    const raw = sessionStorage.getItem(KEY)
    sessionStorage.removeItem(KEY)
    if (!raw) return null
    const kept = JSON.parse(raw) as Partial<CardClaim> & { at?: unknown }
    if (typeof kept.at !== 'number' || now - kept.at > KEEP_FOR) return null
    if (typeof kept.handle !== 'string' || typeof kept.name !== 'string') return null
    if (typeof kept.url !== 'string') return null
    return { handle: kept.handle, name: kept.name, url: kept.url }
  } catch {
    return null
  }
}

/** The signed-in member's handle, as tela-api has it now; null when it cannot say. */
async function currentHandle(): Promise<string | null> {
  try {
    const res = await api('/api/v1/me')
    if (!res.ok) return null
    const body = (await res.json()) as { profile?: { handle?: unknown } | null }
    return typeof body.profile?.handle === 'string' ? body.profile.handle : null
  } catch {
    return null
  }
}

async function putProfile(body: Record<string, string>): Promise<number> {
  try {
    const res = await api('/api/v1/profile', { method: 'PUT', body })
    return res.status
  } catch {
    return 0
  }
}

/**
 * Give the member the card's handle and name while theirs is still provisional, and say where to
 * go next. A handle another member holds (409 `handle_taken`, whether taken meanwhile or all along,
 * since For writers lets a taken one through) still sets the name, and the claim page says the
 * handle is someone else's. One the server refuses (400 `invalid_handle`: reserved, say, which For
 * writers already said) sets the name and says nothing more: "someone else's" would not be true.
 * Anything else that fails goes on to the claim all the same: the blog is what they came for, and
 * the name can be set in Settings.
 */
export async function finishCard(claim: CardClaim): Promise<string> {
  if (!isProvisional(await currentHandle())) return claimPath(claim.url)
  const displayName = claim.name.trim()
  const named = displayName ? { displayName } : {}
  if (!claim.handle) {
    if (displayName) await putProfile(named)
    return claimPath(claim.url)
  }
  const status = await putProfile({ handle: claim.handle, ...named })
  if (status !== 400 && status !== 409) return claimPath(claim.url)
  if (displayName) await putProfile(named)
  return claimPath(claim.url, status === 409)
}

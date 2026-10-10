/**
 * Claiming a blog (ADRs 0011, 0045): what a check found when it found no proof, so the claim page
 * can say what to change rather than what is missing.
 */

/** Tela's old address, which only redirects here (ADR 0042): a link pasted before the move. */
export const FORMER_PUBLIC_HOSTS: readonly string[] = ['tela.ainaive.com']

/** What a link without `rel="me"` led to: the member's Tela profile, or their GitHub. */
export type ClaimTarget = 'profile' | 'github'

/**
 * Why a check found no proof, closest miss first. Stored as JSON in `site_claims.error`; every
 * other failure (the page did not answer, an operator's rejection) stays plain text there.
 */
export type ClaimReason =
  /** Nothing on `page` comes near: no tag, no link to the profile, no GitHub that points back. */
  | { reason: 'no_proof'; page: string }
  /** `page` links the Tela profile `@found`, and the member is `@handle` (a handle changed). */
  | { reason: 'other_handle'; page: string; found: string; handle: string }
  /** The link is marked as someone else's (`nofollow`, `ugc`, `sponsored`): a comment's link. */
  | { reason: 'link_marked'; page: string; target: ClaimTarget; rel: string }
  /** A link without `rel="me"` on the home page that `other`, the blog's 404 page, lacks. */
  | { reason: 'not_site_wide'; page: string; other: string; target: ClaimTarget }
  /** A link without `rel="me"`, and the blog answers a missing address with no 404 page. */
  | { reason: 'no_not_found_page'; page: string; target: ClaimTarget }
  /**
   * The home page links the member's GitHub, whose profile names another website or none. The
   * GitHub's login and website are not in a reason, which is stored: Tela keeps neither (ADR 0036).
   */
  | { reason: 'github_website' }
  /** The member's GitHub names this blog, and `page` does not link to it. */
  | { reason: 'github_link'; page: string }
  /** GitHub did not answer, and nothing else on the page was proof. */
  | { reason: 'github_unavailable' }
  /**
   * A link without `rel="me"` on `page`, on a claim an operator rejected or removed: from then on
   * only the tag or `rel="me"` counts, or the claimant would win back the blog by that link.
   */
  | { reason: 'overruled'; page: string; target: ClaimTarget }

export const CLAIM_REASONS = [
  'no_proof',
  'other_handle',
  'link_marked',
  'not_site_wide',
  'no_not_found_page',
  'github_website',
  'github_link',
  'github_unavailable',
  'overruled',
] as const satisfies readonly ClaimReason['reason'][]

/** The stored reason, or null for a plain-text error (and for anything that is not one). */
export function claimReason(error: string | null | undefined): ClaimReason | null {
  if (!error?.startsWith('{')) return null
  try {
    const parsed = JSON.parse(error) as { reason?: unknown }
    return (CLAIM_REASONS as readonly unknown[]).includes(parsed.reason)
      ? (parsed as ClaimReason)
      : null
  } catch {
    return null
  }
}

const TARGETS: Record<ClaimTarget, string> = {
  profile: 'your Tela profile',
  github: 'your GitHub',
}

/**
 * A stored error in English: a reason in words, anything else as it was written. For the admin
 * console, and for a claim page cached before reasons existed, which shows only this text. The
 * claim page says the same in the member's language from its catalogue.
 */
export function describeClaimError(error: string): string {
  const r = claimReason(error)
  if (!r) return error
  switch (r.reason) {
    case 'no_proof':
      return `no meta tag with the token, no link to your Tela profile, and no GitHub that links back on ${r.page}`
    case 'other_handle':
      return `${r.page} links the Tela profile @${r.found}, not @${r.handle}`
    case 'link_marked':
      return `the link to ${TARGETS[r.target]} on ${r.page} is marked rel="${r.rel}", as a comment's is`
    case 'not_site_wide':
      return `the link to ${TARGETS[r.target]} has no rel="me", and is on ${r.page} but not on the blog's 404 page, ${r.other}`
    case 'no_not_found_page':
      return `the link to ${TARGETS[r.target]} on ${r.page} has no rel="me", and the blog has no 404 page to find it on again`
    case 'github_website':
      return "the home page links your GitHub, and your GitHub's website is not this blog"
    case 'github_link':
      return `your GitHub names this blog as its website, and ${r.page} does not link to it`
    case 'github_unavailable':
      return 'GitHub did not answer'
    case 'overruled':
      return `an operator ruled on this claim, so the link to ${TARGETS[r.target]} on ${r.page} counts only with rel="me"`
  }
}

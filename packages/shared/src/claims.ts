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
  /** A link without `rel="me"` on the home page that `other`, an older post, does not repeat. */
  | { reason: 'not_site_wide'; page: string; other: string; target: ClaimTarget }
  /** A link without `rel="me"`, and no post of the blog to look for it on yet. */
  | { reason: 'no_second_page'; page: string; target: ClaimTarget }
  /** The home page links `github.com/login`, whose profile names `website` (empty: none). */
  | { reason: 'github_website'; login: string; website: string }
  /** The member's GitHub names this blog, and `page` does not link `github.com/login`. */
  | { reason: 'github_link'; page: string; login: string }
  /** GitHub did not answer, and nothing else on the page was proof. */
  | { reason: 'github_unavailable' }

export const CLAIM_REASONS = [
  'no_proof',
  'other_handle',
  'link_marked',
  'not_site_wide',
  'no_second_page',
  'github_website',
  'github_link',
  'github_unavailable',
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
 * A stored error in English, for the admin console and logs: a reason in words, anything else as
 * it was written. The claim page says the same in the member's language from its catalogue.
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
      return `the link to ${TARGETS[r.target]} has no rel="me", and is on ${r.page} but not on ${r.other}`
    case 'no_second_page':
      return `the link to ${TARGETS[r.target]} on ${r.page} has no rel="me", and there is no post yet to find it on again`
    case 'github_website':
      return `the home page links github.com/${r.login}, whose website is ${r.website || 'not set'}`
    case 'github_link':
      return `your GitHub names this blog, but ${r.page} does not link github.com/${r.login}`
    case 'github_unavailable':
      return 'GitHub did not answer'
  }
}

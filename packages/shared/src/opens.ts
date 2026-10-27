/**
 * The day's limit on posts opened from blogs a member does not follow (ADR 0066): what tela-api
 * answers an edge (tela-web or tela-gateway) that asks whether a member may have these content
 * objects. A key of a post from a blog they subscribe to is always allowed; any other is counted,
 * once a UTC day, against `member.unsubscribedPostsPerDay`.
 */

/** The most content keys one decision names: a bundle's worth. */
export const OPENS_KEYS_MAX = 25

export type OpensRefusal = {
  error: 'post_limit'
  /** The day's limit, when the refusal is for it. */
  limit: number
  /** When the day's count starts again: the next UTC midnight, epoch ms. */
  resetsAt: number
}

export type OpensDecision = {
  /** Keys the member may have now. */
  allowed: string[]
  /** Keys refused, and why. */
  refused: Record<string, OpensRefusal>
}

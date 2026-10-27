/**
 * What opening a post does before its body is on screen, which depends on whether the day's limit
 * on blogs the member does not subscribe to can refuse that body (ADR 0066). A subscribed blog's
 * post never is, so its translation is asked for the moment it opens, as always. Any other's waits
 * for the body: refused, a translation would be paid for and refused with it.
 */

/**
 * Whether the reader asks for a post's translation now: when it is wanted, and either the post is
 * from a blog the member subscribes to (its body is never refused, so asking at once saves the
 * first paragraphs a round trip), or its body has answered, and was not refused.
 */
export function asksForTranslation(post: {
  wanted: boolean
  subscribed: boolean
  answered: boolean
  refused: boolean
}): boolean {
  return post.wanted && !post.refused && (post.subscribed || post.answered)
}

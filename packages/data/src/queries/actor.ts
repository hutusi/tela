/**
 * Who an action is taken for (ADRs 0064, 0066). Every rule the web and the API share takes one,
 * and never reads a request: the web's routes pass `exempt` from `is_admin`, the API always passes
 * `false`, because an app is never an admin in any way, limits included.
 */
export type Actor = {
  userId: string
  /** Free of the member limits (translations, feeds, subscriptions, unfollowed posts). */
  exempt: boolean
}

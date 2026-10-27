/**
 * What a member has used of their limits today (ADR 0063), and of the day's posts from blogs they
 * do not follow (ADR 0066): the answer the web's `/api/v1/account/usage` and the API's `/v1/usage`
 * share (ADR 0065). Live, never synced. A limit the actor is exempt from (an admin on the web;
 * never an app, ADR 0064) reads as none.
 */
import { type Actor, memberAllowances, nextUtcDay } from '@tela/data'
import type { AccountPosts, AccountUsage } from '@tela/shared'
import type { ApiDeps } from '../deps'

/** The usage answer, posts opened today included: this tela-api always says it. */
export type Usage = AccountUsage & { posts: AccountPosts }

export async function readUsage(deps: ApiDeps, actor: Actor): Promise<Usage> {
  const now = deps.clock.now()
  const used = await memberAllowances(deps.db, actor.userId, now, actor.exempt)
  const none = (limit: number | null) => (used.exempt ? null : limit)
  return {
    translations: {
      perDay: none(used.translations.perDay),
      usedToday: used.translations.usedToday,
      waiting: used.translations.waiting,
      resetsAt: nextUtcDay(now),
    },
    feeds: {
      perDay: none(used.feeds.perDay),
      addedToday: used.feeds.addedToday,
      pending: used.feeds.pending,
    },
    subscriptions: { max: none(used.subscriptions.max), count: used.subscriptions.count },
    posts: {
      perDay: none(used.posts.perDay),
      openedToday: used.posts.openedToday,
      resetsAt: nextUtcDay(now),
    },
    exempt: used.exempt,
  }
}

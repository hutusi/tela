/**
 * What a signed-in member can do on a public page, from the local store: see and change their
 * subscription and whom they follow at once (mutations, pushed behind), and open a post in the
 * reader whether or not the device syncs its feed.
 */
import { type ArticleRow, pastSubscriptionCap, subscriptionCount, type Tables } from '@tela/sync'
import { useCallback, useEffect, useMemo } from 'react'
import { useTranslations } from 'use-intl'
import { useSession } from '../session'
import { useStore, useTables } from '../store/hooks'
import type { MemberControls } from '../views/types'
import { readingHref } from './href'
import { showToast } from './toasts'
import { primeUsage, subscriptionCap } from './usage'

/** Why subscribing to `adding` more is refused (a `toast` message and its values), or null. */
export function capRefusal(
  t: Pick<Tables, 'subscriptions'>,
  cap: number | null,
  adding: number,
):
  | { message: 'subscriptionLimit'; values: { max: number } }
  | { message: 'subscriptionLimitMany'; values: { n: number; max: number; room: number } }
  | null {
  if (cap === null || !pastSubscriptionCap(t, cap, adding)) return null
  const room = Math.max(0, cap - subscriptionCount(t))
  // Several that do not all fit say how many would; one, or none left, says the cap.
  return adding > 1 && room > 0
    ? { message: 'subscriptionLimitMany', values: { n: adding, max: cap, room } }
    : { message: 'subscriptionLimit', values: { max: cap } }
}

/**
 * A check before subscribing to `adding` more blogs (ADR 0063): true, and a toast saying why, when
 * that would hold more than the member's cap. The server refuses a subscribe past it without a
 * word, so the device says it first, from the cap its usage answer gave; one it was not given
 * refuses nothing. Reads the rows as they are when it runs, pending changes included.
 */
export function useSubscriptionCap(): (adding: number) => boolean {
  const { store } = useStore()
  const t = useTranslations('toast')
  return useCallback(
    (adding: number) => {
      const refusal = capRefusal(store.getSnapshot().tables, subscriptionCap(store.userId), adding)
      if (!refusal) return false
      showToast(t(refusal.message, refusal.values))
      return true
    },
    [store, t],
  )
}

export function useMemberControls(): MemberControls | undefined {
  const { status } = useSession()
  const { store } = useStore()
  const tables = useTables()
  const pastCap = useSubscriptionCap()
  // A page that offers Subscribe asks, once per tab, how many the member may hold.
  useEffect(() => {
    if (status === 'member') primeUsage(store.userId)
  }, [status, store])
  return useMemo(() => {
    if (status !== 'member') return undefined
    const isSubscribed = (feedId: number) => tables.subscriptions.get(feedId)?.deletedAt === null
    return {
      isSubscribed,
      toggle(feedId, subscribed) {
        if (!subscribed && pastCap(1)) return
        store.mutate(subscribed ? { type: 'unsubscribe', feedId } : { type: 'subscribe', feedId })
      },
      readHref: (article: ArticleRow) =>
        readingHref({
          feedId: isSubscribed(article.feedId) ? article.feedId : null,
          articleId: article.id,
        }),
      hold: (article: ArticleRow, source: string | null) => store.remember([article], source),
      handle: tables.profile?.handle ?? null,
      userId: store.userId,
      isFollowing: (userId: string) => tables.follows.has(userId),
      setFollowing(person, follow) {
        store.rememberPeople([person])
        store.mutate(
          follow ? { type: 'follow', userId: person.id } : { type: 'unfollow', userId: person.id },
        )
      },
    }
  }, [status, store, tables, pastCap])
}

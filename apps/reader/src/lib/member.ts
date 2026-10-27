/**
 * What a signed-in member can do on a public page, from the local store: see and change their
 * subscription and whom they follow at once (mutations, pushed behind), and open a post in the
 * reader whether or not the device syncs its feed.
 */
import { type ArticleRow, pastSubscriptionCap, subscriptionCount, type Tables } from '@tela/sync'
import { useCallback, useEffect, useMemo } from 'react'
import { useTranslations } from 'use-intl'
import { useSession } from '../session'
import { apiJson } from '../store/api'
import { useStore, useTables } from '../store/hooks'
import type { LocalStore } from '../store/local'
import type { MemberControls, PublicArticle } from '../views/types'
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

/**
 * Hold a public page's post for the reader (ADR 0066). The page carries no content key, so the
 * post's row is fetched by id, as the member's device would have synced it, and kept with the
 * titles the page showed. One the device holds already, with its key, is opened as it is. While
 * the row is on its way the reader shows the post loading (`isFetching`); if it cannot come (the
 * network, or a tela-api from before the route), the page's row is kept as it is, so the reader
 * still names the post and links to the blog. A tela-api from before ADR 0066 sent the key itself.
 */
export async function holdArticle(
  store: LocalStore,
  article: PublicArticle,
  source: string | null,
): Promise<void> {
  const page: ArticleRow = { ...article, contentKey: article.contentKey ?? null }
  if (article.contentKey !== undefined) return store.remember([page], source)
  const held = store.article(store.getSnapshot().tables, article.id)
  if (held?.contentKey) return
  const epoch = store.beginHold(article.id)
  const member = store.userId
  try {
    const { status, body } = await apiJson<{ article?: ArticleRow }>(
      `/api/v1/articles/${article.id}`,
      { member },
    )
    // Not found is a post Tela no longer holds: the reader says it is gone.
    if (status === 404) return store.endHold(epoch, article.id, null)
    const row = status === 200 && body?.article ? { ...article, ...body.article } : page
    store.endHold(epoch, article.id, row, source)
  } catch {
    store.endHold(epoch, article.id, page, source)
  }
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
      readHref: (article) =>
        readingHref({
          feedId: isSubscribed(article.feedId) ? article.feedId : null,
          articleId: article.id,
        }),
      hold: (article, source) => void holdArticle(store, article, source),
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

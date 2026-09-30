/**
 * What a signed-in member can do on a public page, from the local store: see and change their
 * subscription and whom they follow at once (mutations, pushed behind), and open a post in the
 * reader whether or not the device syncs its feed.
 */
import type { ArticleRow } from '@tela/sync'
import { useMemo } from 'react'
import { useSession } from '../session'
import { useStore, useTables } from '../store/hooks'
import type { MemberControls } from '../views/types'
import { readingHref } from './href'

export function useMemberControls(): MemberControls | undefined {
  const { status } = useSession()
  const { store } = useStore()
  const tables = useTables()
  return useMemo(() => {
    if (status !== 'member') return undefined
    const isSubscribed = (feedId: number) => tables.subscriptions.get(feedId)?.deletedAt === null
    return {
      isSubscribed,
      toggle(feedId, subscribed) {
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
  }, [status, store, tables])
}

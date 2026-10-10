/**
 * What a member's device adds to Discover's public answers (ADR 0044): which blogs they already
 * read, so their posts stay out of the way, and who among a post's recommenders they follow.
 * Nothing of it goes to the server: the answers are the same for everyone, and so is the edge's
 * page.
 */
import type { Tables } from '@tela/sync'
import type { DiscoverPost, Person } from '../views/types'

/** Whether a blog is one the member reads: by site, or by feed for a post the device holds no feed of. */
export type Hidden = (siteId: number, feedId?: number | null) => boolean

export const NOTHING_HIDDEN: Hidden = () => false

/**
 * The blogs the member reads, as of now. A page takes it once when it opens, so the blog they
 * subscribe to from the page stays on it, showing "Subscribed", until they come back.
 */
export function hiddenOf(tables: Tables): Hidden {
  const feeds = new Set<number>()
  const sites = new Set<number>()
  for (const s of tables.subscriptions.values()) {
    if (s.deletedAt !== null) continue
    feeds.add(s.feedId)
    const feed = tables.feeds.get(s.feedId)
    if (feed) sites.add(feed.siteId)
  }
  return (siteId, feedId) => sites.has(siteId) || (feedId != null && feeds.has(feedId))
}

/**
 * The people the member follows among a post's recommenders, newest recommendation first, named
 * by the follow row, or by the post's note when the pull has not named a new follow yet.
 */
export function followedAmong(post: DiscoverPost, follows: Tables['follows']): Person[] {
  const people: Person[] = []
  for (const id of post.recommenders) {
    const f = follows.get(id)
    if (!f) continue
    if (f.handle) {
      people.push({ id, handle: f.handle, displayName: f.displayName, avatar: f.avatar ?? null })
    } else if (post.note?.person.id === id) {
      people.push(post.note.person)
    }
  }
  return people
}

/**
 * Why a post is on Discover, for the line under its title: someone the member follows recommends
 * it, else how many readers did this week. None for a post nobody recommended this week.
 */
export type PostReason =
  | { kind: 'followed'; people: Person[]; others: number }
  | { kind: 'week'; count: number }
  | null

export function postReason(post: DiscoverPost, followed: readonly Person[]): PostReason {
  if (followed.length > 0) {
    // Everyone who recommends it, from the post's own count: the answer names only the newest
    // twenty recommenders, so their number is no total.
    const total = Math.max(post.article.recommendCount, post.recommenders.length)
    return { kind: 'followed', people: [...followed], others: Math.max(total - followed.length, 0) }
  }
  return post.weekRecs > 0 ? { kind: 'week', count: post.weekRecs } : null
}

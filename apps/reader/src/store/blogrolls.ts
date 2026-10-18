/**
 * What the member's own blogrolls look like from the local tables (ADR 0050): the owner's page,
 * profile tab and cards read these, never tela-api. Others' blogrolls come by RPC.
 */
import type { BlogrollBlogRow, BlogrollRow, Tables } from '@tela/sync'
import type { BlogrollCard, Person } from '../views/types'
import { cached } from './selectors'

/** How many blogs a card names before "N blogs". */
export const CARD_BLOGS = 3

/** The member's live blogrolls, newest first. */
export function myBlogrolls(t: Tables): BlogrollRow[] {
  return cached(t, 'blogrolls', () =>
    [...t.blogrolls.values()].sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? -1 : 1)),
  )
}

/** The blogs in one of the member's blogrolls, removed ones left out, in the order put in. */
export function liveBlogs(t: Tables, blogrollId: string): BlogrollBlogRow[] {
  return cached(t, `blogroll:${blogrollId}`, () => {
    const out: BlogrollBlogRow[] = []
    for (const row of t.blogrollBlogs.values()) {
      if (row.blogrollId === blogrollId && row.removedAt === null) out.push(row)
    }
    return out.sort((a, b) => a.addedAt - b.addedAt || a.feedId - b.feedId)
  })
}

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

/**
 * What a blog in a blogroll is called, as tela-api names it for others (`blogNameSql`): its
 * blog's title, or the feed's own when the blogroll holds another feed of the same blog, else the
 * blog's host. Null while the device holds no row for the feed (before the pull brings it).
 */
export function blogNameIn(
  t: Tables,
  blogs: readonly BlogrollBlogRow[],
  feedId: number,
): string | null {
  const feed = t.feeds.get(feedId)
  if (!feed) return null
  const site = t.sites.get(feed.siteId)
  const sibling = blogs.some(
    (b) => b.feedId !== feedId && t.feeds.get(b.feedId)?.siteId === feed.siteId,
  )
  const name = sibling ? (feed.title ?? site?.title) : (site?.title ?? feed.title)
  return name ?? (site ? hostOf(site.homeUrl) : null)
}

/**
 * The member's own blogroll as a card. Unlike a card tela-api sends, it counts every blog in it,
 * those the operator hid from others included: the card is the owner's.
 */
export function ownCard(t: Tables, row: BlogrollRow, owner: Person): BlogrollCard {
  const blogs = liveBlogs(t, row.id)
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    owner,
    blogCount: blogs.length,
    blogs: blogs.slice(0, CARD_BLOGS).map((b) => {
      const site = t.sites.get(t.feeds.get(b.feedId)?.siteId ?? -1)
      return {
        feedId: b.feedId,
        siteId: site?.id ?? 0,
        name: blogNameIn(t, blogs, b.feedId),
        homeUrl: site?.homeUrl ?? '',
      }
    }),
    publicSince: null,
    updatedAt: Math.max(row.updatedAt, ...blogs.map((b) => Math.max(b.updatedAt, b.noteAt))),
  }
}

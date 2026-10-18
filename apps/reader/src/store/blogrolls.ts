/**
 * What the member's own blogrolls look like from the local tables (ADR 0050): the owner's page,
 * profile tab and cards read these, never tela-api. Others' blogrolls come by RPC.
 */
import type { BlogrollBlogRow, BlogrollRow, Tables } from '@tela/sync'
import type { BlogrollBlog, BlogrollCard, BlogrollData, Person } from '../views/types'
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
 * What a blog in a blogroll is called, as tela-api names it for others (`BLOG_NAME`): its blog's
 * title, or the feed's own once the blogroll has held another feed of the same blog (rows taken
 * out count, so taking a neighbour out renames nothing), else the blog's host. Null while the
 * device holds no row for the feed (before the pull brings it).
 */
export function blogNameIn(t: Tables, blogrollId: string, feedId: number): string | null {
  const feed = t.feeds.get(feedId)
  if (!feed) return null
  const site = t.sites.get(feed.siteId)
  let sibling = false
  for (const row of t.blogrollBlogs.values()) {
    if (row.blogrollId !== blogrollId || row.feedId === feedId) continue
    if (t.feeds.get(row.feedId)?.siteId === feed.siteId) sibling = true
  }
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
        name: blogNameIn(t, row.id, b.feedId),
        homeUrl: site?.homeUrl ?? '',
      }
    }),
    publicSince: null,
    updatedAt: Math.max(row.updatedAt, ...blogs.map((b) => Math.max(b.updatedAt, b.noteAt))),
  }
}

/** The member's own blogrolls as cards, newest first: their profile tab's. */
export function myBlogrollCards(t: Tables, owner: Person): BlogrollCard[] {
  return myBlogrolls(t).map((row) => ownCard(t, row, owner))
}

/**
 * What the owner's page says of a blog that others' pages do not: that the member no longer
 * follows it (it stays in the blogroll), and that the operator hid its blog, so nobody else sees
 * it here.
 */
export type OwnBlogFlags = { notSubscribed: boolean; hiddenFromOthers: boolean }

/** Below this, a blog's readers are nobody's to count (ADR 0041): the row says nothing of them. */
const READERS_SHOWN_FROM = 3

/**
 * The member's own blogroll as its page shows it, from the device's rows (ADR 0050): what
 * tela-api would answer for it, but with every blog the member put in, those the operator hid
 * included, each with what only the owner is told (`OwnBlogFlags`). A blog whose feed the device
 * holds no row for yet (before the pull brings it) has no name, and its host is blank. Null for a
 * blogroll the device does not hold.
 */
export function selectBlogrollPage(
  t: Tables,
  id: string,
  owner: Person,
): { data: BlogrollData; flags: ReadonlyMap<number, OwnBlogFlags> } | null {
  const row = t.blogrolls.get(id)
  if (!row) return null
  const key = `blogrollPage:${id}:${owner.id}:${owner.handle}:${owner.displayName}:${owner.avatar}`
  return cached(t, key, () => {
    const live = liveBlogs(t, id)
    const flags = new Map<number, OwnBlogFlags>()
    const blogs = live.map((b): BlogrollBlog => {
      const feed = t.feeds.get(b.feedId)
      const site = feed ? t.sites.get(feed.siteId) : undefined
      flags.set(b.feedId, {
        notSubscribed: t.subscriptions.get(b.feedId)?.deletedAt !== null,
        hiddenFromOthers: site?.listing === 'rejected',
      })
      return {
        feedId: b.feedId,
        siteId: site?.id ?? 0,
        name: blogNameIn(t, id, b.feedId),
        homeUrl: site?.homeUrl ?? feed?.feedUrl ?? '',
        faviconKey: site?.faviconKey ?? null,
        primaryLang: site?.primaryLang ?? null,
        description: site?.description ?? null,
        listed: site?.listing === 'listed' || site?.listing === 'featured',
        readerCount: site && site.readerCount >= READERS_SHOWN_FROM ? site.readerCount : null,
        dead: feed?.status === 'dead',
        note: b.note,
        addedAt: b.addedAt,
      }
    })
    const data: BlogrollData = {
      blogroll: {
        id: row.id,
        name: row.name,
        description: row.description,
        updatedAt: Math.max(row.updatedAt, ...live.map((b) => Math.max(b.updatedAt, b.noteAt))),
      },
      owner,
      blogs,
    }
    return { data, flags }
  })
}

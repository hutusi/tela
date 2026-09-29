/** What tela-api's public endpoints return (`/api/v1/public/*`): the data a public page renders. */
import type { ArticleRow } from '@tela/sync'

export type DiscoverSite = {
  id: number
  title: string | null
  homeUrl: string
  description: string | null
  faviconKey: string | null
  primaryLang: string | null
  listing: string
  claimed: boolean
  readerCount: number
  feedId: number | null
  latestTitle: string | null
  latestAt: number | null
  postsLast30d: number
  topics: string[]
}

export type DiscoverData = { sites: DiscoverSite[]; languages: { lang: string; count: number }[] }

export type SiteData = {
  site: {
    id: number
    title: string | null
    homeUrl: string
    description: string | null
    faviconKey: string | null
    primaryLang: string | null
    listing: string
    readerCount: number
    /** The claimant's handle. */
    claimedBy: string | null
  }
  feeds: { id: number; feedUrl: string; title: string | null }[]
  posts: ArticleRow[]
  topics: string[]
}

export type ProfileData = {
  profile: { handle: string; displayName: string | null; bio: string | null; memberSince: number }
  blogs: { id: number; title: string | null; homeUrl: string; faviconKey: string | null }[]
  recommendations: {
    note: string | null
    createdAt: number
    siteId: number
    siteTitle: string | null
    homeUrl: string
    article: ArticleRow
  }[]
  subscriptions:
    | {
        id: number
        title: string | null
        homeUrl: string
        faviconKey: string | null
        listed: boolean
      }[]
    | null
}

/** What a member adds to a public page: their own subscription state, and ways to act on it. */
export type MemberControls = {
  isSubscribed(feedId: number): boolean
  toggle(feedId: number, subscribed: boolean): void
  /** Where the reader opens a post. */
  readHref(article: ArticleRow): string
  /** Hold a post for this visit, when the device does not sync its feed; `source` names its blog. */
  hold(article: ArticleRow, source: string | null): void
  /** The member's handle: a blog claimed under it has settings that are theirs to change. */
  handle: string | null
}

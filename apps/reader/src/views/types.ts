/** What tela-api's public endpoints return (`/api/v1/public/*`): the data a public page renders. */
import type { ArticleRow } from '@tela/sync'

/**
 * A post on a public page: the row the reader holds, with its titles in the launch languages it
 * has one in, since the page is cached for everyone and each reader picks their own.
 */
export type PublicArticle = ArticleRow & { titles?: Partial<Record<string, string>> }

/** Which language a public page's reader reads in, and which they read as written. */
export type Reading = { lang: string; never: readonly string[] }

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

/** A member as a page names them: their handle, and their name if they gave one. */
export type PersonRef = { handle: string; displayName: string | null }

/** A member someone can follow: named, and with the account id a follow names (ADR 0031). */
export type Person = PersonRef & { id: string }

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
    /** Who writes it, for the About: the claimant's own name and bio. */
    claimant: (PersonRef & { bio: string | null }) | null
    /** Null when the answering tela-api does not say (one from before ADR 0031). */
    postsLast30d: number | null
  }
  feeds: { id: number; feedUrl: string; title: string | null }[]
  posts: PublicArticle[]
  topics: string[]
  /** Recent recommendations of its posts that came with a note. */
  notes: { note: string; createdAt: number; person: PersonRef; article: PublicArticle }[]
}

/** A post on a profile: the article, its blog, and whether that blog has a public page. */
type ProfilePost = {
  siteId: number
  siteTitle: string | null
  homeUrl: string
  listed: boolean
  article: PublicArticle
}

export type ProfileCounts = {
  following: number
  followers: number
  recommendations: number
  /** Null unless the member shows their liked posts, or their subscriptions. */
  liked: number | null
  subscriptions: number | null
}

export type ProfileData = {
  profile: {
    /** The account id, which a follow names (ADR 0031). */
    id: string
    handle: string
    displayName: string | null
    bio: string | null
    memberSince: number
  }
  /** Null from a tela-api before follows (ADR 0031), which counts nothing: shown as absent, never 0. */
  counts: ProfileCounts | null
  blogs: { id: number; title: string | null; homeUrl: string; faviconKey: string | null }[]
  recommendations: (ProfilePost & { note: string | null; createdAt: number })[]
  subscriptions:
    | {
        id: number
        title: string | null
        homeUrl: string
        description: string | null
        faviconKey: string | null
        listed: boolean
      }[]
    | null
  liked: (ProfilePost & { likedAt: number })[] | null
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
  /** The member's account id: their own profile offers no Follow. */
  userId: string | null
  isFollowing(userId: string): boolean
  /** Follow someone or stop, at once; the page names them until the pull does (ADR 0031). */
  setFollowing(person: Person, follow: boolean): void
}

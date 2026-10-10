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
  claimed: boolean
  /** Null below three readers: a smaller count is nobody's to publish (ADR 0041). */
  readerCount: number | null
  feedId: number | null
  latestTitle: string | null
  latestAt: number | null
  postsLast30d: number
  topics: string[]
}

/** One page of Discover. `total` is every blog the filters match; an older answer has none. */
export type DiscoverData = {
  sites: DiscoverSite[]
  languages: { lang: string; count: number }[]
  total?: number
  pageSize?: number
}

/**
 * A post in the front page's edition: the newest of one public blog, with its excerpt translated
 * into the launch languages it has one in, beside its titles.
 */
export type FrontPost = {
  article: PublicArticle & { excerpts?: Partial<Record<string, string>> }
  site: {
    id: number
    title: string | null
    homeUrl: string
    faviconKey: string | null
    primaryLang: string | null
  }
  claimant: { handle: string; displayName: string | null } | null
}

/**
 * The front page (`/api/v1/public/front`): how many public blogs there are, what the last seven
 * days held, and the edition: one post a blog, from the week when the week has any, else the
 * latest there are.
 */
export type FrontData = {
  counts: { blogs: number }
  week: { blogs: number; languages: number; posts: number }
  edition: { span: 'week' | 'latest'; posts: FrontPost[] }
}

/**
 * A member as a page names them: their handle, their name if they gave one, and their picture's
 * address while they show one (ADR 0032; absent from a tela-api before it).
 */
export type PersonRef = { handle: string; displayName: string | null; avatar?: string | null }

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
    /** Null below three readers, as on Discover. */
    readerCount: number | null
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
    /** Their picture's address, while they show one (ADR 0032). */
    avatar?: string | null
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

/** A post's blog on Discover's posts and readers. */
export type PostSite = {
  id: number
  title: string | null
  homeUrl: string
  faviconKey: string | null
  primaryLang: string | null
  claimed: boolean
}

/**
 * A post on Discover (ADR 0044), the same for everyone who asks: the device works out what is
 * its member's own, such as who among its recommenders they follow.
 */
export type DiscoverPost = {
  article: PublicArticle & { excerpts?: Partial<Record<string, string>> }
  site: PostSite
  /** Live recommendations made in the last seven days. */
  weekRecs: number
  /** Who recommends it, newest first and at most twenty: account ids, as a follow names them. */
  recommenders: string[]
  /** The newest recommendation of it that came with a note. */
  note: { text: string; person: Person } | null
}

/** A post a reader recommended, with its blog. */
export type ReaderPost = { article: PublicArticle; site: PostSite }

/**
 * A member Discover may suggest following (ADR 0044): everything here is already public on their
 * profile. The device matches it against its own member's likes, recommendations and blogs.
 */
export type ReaderCandidate = Person & {
  bio: string | null
  /** Their newest live recommendations, as [articleId, siteId]. */
  recs: [number, number][]
  /** Listed blogs they read, by site id; null unless they show what they read. */
  sites: number[] | null
  /** Live recommendations in the last thirty days, and how many of those came with a note. */
  recent: number
  withNote: number
  /** Every live recommendation they have made. */
  total: number
  /** The post they recommended before the most other readers did, from two others up. */
  early: (ReaderPost & { others: number }) | null
  /** Their newest recommendation with a note, of a post on a listed blog. */
  sample: (ReaderPost & { note: string }) | null
}

/** This week on Discover (`/api/v1/public/discover/week`); the device composes the page. */
export type WeekData = {
  since: number
  /** Posts recommended in the last seven days, the most recommended first. */
  recommended: DiscoverPost[]
  /** The front page's edition: one post a blog, from the week, else the latest there are. */
  edition: { span: 'week' | 'latest'; posts: DiscoverPost[] }
  /** Blogs new to the directory, newest first. */
  newBlogs: DiscoverSite[]
  readers: ReaderCandidate[]
}

/**
 * One page of Discover's Articles (`/api/v1/public/discover/articles`): the newest posts, and on
 * the first page the week's recommended ones, which are never paged since their counts move.
 */
export type ArticlesData = {
  recommended: DiscoverPost[]
  posts: DiscoverPost[]
  next: string | null
  languages: { lang: string; count: number }[]
}

/** Discover's Readers (`/api/v1/public/discover/readers`). */
export type ReadersData = { readers: ReaderCandidate[] }

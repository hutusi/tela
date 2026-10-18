/** Claims, Sites, Feeds and Discover: the blogs Tela knows and the queues about them. */
import type {
  ClaimMethod,
  ClaimStatus,
  FeedFormat,
  FeedStatus,
  FetchRegion,
  SiteListing,
  SiteReview,
} from '../constants'
import type { AdminHistoryEntry, AdminPerson, AdminRowBase } from './common'

/** The error a claim an operator removed shows its claimant, and how the console tells it apart. */
export const CLAIM_REMOVED_ERROR = 'removed by an operator'

/** A blog as every library ledger shows it. */
export type AdminSiteRow = AdminRowBase & {
  siteId: number
  title: string | null
  homeUrl: string
  faviconKey: string | null
  listing: SiteListing
  owner: AdminPerson | null
  readerCount: number
  feedCount: number
  /** The worst state among its feeds; `none` when it has no feed left. */
  feedHealth: 'ok' | 'failing' | 'timeout' | 'dead' | 'paused' | 'none'
  /** A claim on it is failing and not yet reviewed. */
  claimFailing: boolean
  primaryLang: string | null
  translationOptOut: boolean
  topics: string[]
  /** When it was added: its first feed. */
  createdAt: number
  /** Posts its live feeds brought in the last 30 days, the newest one's title and time. */
  postsLast30d: number
  latestTitle: string | null
  latestAt: number | null
  /**
   * What an operator's review decided for Discover (ADR 0041): `listed` (List, Feature, curation)
   * or `dismissed` (Not for Discover, or a Hide over nothing decided). Null while a blog a member
   * added waits in the review queue. Never who added it: what a member reads is not the
   * console's to show (ADR 0039).
   */
  review: SiteReview | null
  /** When an operator last decided about it for Discover (Hide included); null with `review`. */
  reviewedAt: number | null
}

export type AdminClaimRow = AdminRowBase & {
  claimId: number
  siteId: number
  siteTitle: string | null
  homeUrl: string
  /** The blog's favicon, for the row's tile. */
  faviconKey: string | null
  claimant: AdminPerson | null
  /** The site's owner when it is someone other than the claimant: a disputed claim. */
  owner: AdminPerson | null
  method: ClaimMethod
  status: ClaimStatus
  error: string | null
  vouched: boolean
  createdAt: number
  lastCheckedAt: number | null
  verifiedAt: number | null
  reviewedAt: number | null
  /** From the claim's lease while it is held or backing off. */
  attempts: number | null
  nextTry: number | null
  readerCount: number
}

export type AdminFeedRow = AdminRowBase & {
  feedId: number
  siteId: number
  siteTitle: string | null
  homeUrl: string
  /** The blog's favicon, for the row's tile. */
  faviconKey: string | null
  feedUrl: string
  format: FeedFormat | null
  status: FeedStatus
  region: FetchRegion
  errorCount: number
  timeoutStreak: number
  lastError: string | null
  lastFetchedAt: number | null
  lastItemAt: number | null
  nextFetchAt: number
  mergedInto: number | null
  owner: AdminPerson | null
  readerCount: number
}

export type AdminSiteDetail = {
  site: AdminSiteRow
  description: string | null
  claimedAt: number | null
  feeds: AdminFeedRow[]
  claims: AdminClaimRow[]
  /** Tokens spent translating it in the last 30 days. */
  tokens30d: number
  history: AdminHistoryEntry[]
}

export type AdminClaimDetail = {
  claim: AdminClaimRow
  /** The head of the token the page must carry, enough to compare with what is there. */
  tokenHead: string
  history: AdminHistoryEntry[]
}

export type AdminFeedDetail = {
  feed: AdminFeedRow
  /** Whether the China relay is configured; without it, `feed.relay` is refused (`no_relay`). */
  relay: boolean
  history: AdminHistoryEntry[]
}

/** A blog in a blogroll, as the console names it. */
export type AdminBlogrollBlog = {
  feedId: number
  siteId: number
  /** What others see it called (`BLOG_NAME`); null when it has no title, and the host stands in. */
  name: string | null
  homeUrl: string
  faviconKey: string | null
}

/**
 * A member's public blogroll in Discover's ledger (ADR 0050). Only public, live blogrolls are
 * listed or opened: a private one is its member's alone, and the console never names it. The
 * owner is shown, since the blogroll is published under their handle.
 */
export type AdminBlogrollRow = AdminRowBase & {
  blogrollId: string
  name: string
  description: string
  owner: AdminPerson | null
  /** The blogs others see: put in, not taken out, and not a blog the operator hid. */
  blogCount: number
  /** Every blog put in and not taken out, those the operator hid included. */
  totalCount: number
  /** When it first went public; Discover pages by it. */
  publicSince: number | null
  /** When an operator hid it from Discover; null while it may be listed. */
  hiddenAt: number | null
  /** Whether Discover lists it now: not hidden, with enough blogs others see. */
  inDiscover: boolean
  /** Its first few blogs others see, in its own order. */
  blogs: AdminBlogrollBlog[]
}

export type AdminBlogrollDetail = {
  blogroll: AdminBlogrollRow
  /** Every blog in it, in its order; `shown` is false for a blog the operator hid. */
  blogs: (AdminBlogrollBlog & { shown: boolean })[]
  history: AdminHistoryEntry[]
}

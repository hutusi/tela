/** Claims, Sites, Feeds and Discover: the blogs Tela knows and the queues about them. */
import type {
  ClaimMethod,
  ClaimStatus,
  FeedFormat,
  FeedStatus,
  FetchRegion,
  SiteListing,
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
   * When an operator decided about it for Discover (ADR 0041): listed, featured, hidden, or not
   * for Discover. Null while a blog a member added waits in the review queue. Never who added it:
   * what a member reads is not the console's to show (ADR 0039).
   */
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

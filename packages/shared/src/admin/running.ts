/** Translation, System and the Overview: how Tela is running, and what it costs. */

import type { AdminHistoryEntry, AdminRowBase } from './common'
import type { AdminClaimRow, AdminFeedRow, AdminSiteRow } from './library'

/** The health check's questions (ADR 0027), each with what it found and where it turns red. */
export const HEALTH_CHECKS = [
  'overdueFeeds',
  'deadLetters',
  'stuckBodies',
  'extractionBacklog',
  'tickErrors',
  'backupAge',
  'backupVerified',
] as const
export type HealthCheckName = (typeof HEALTH_CHECKS)[number]

export type HealthCheck = {
  name: HealthCheckName
  /** A count, or for `backupAge` hours since the last backup; null when there is none yet. */
  value: number | null
  /** The most that is still healthy; null for a yes/no check. */
  limit: number | null
  ok: boolean
}

export type AdminHealth = { ok: boolean; at: number; checks: HealthCheck[] }

/** What tela-jobs last reported about itself: each periodic run, and the switches it runs with. */
export type AdminHeartbeats = {
  tick: number | null
  daily: number | null
  digest: number | null
  /** From the tick's heartbeat; null until a tick that reports it has run. */
  config: {
    /**
     * The day's background (title) budget in tokens as it holds (ADR 0057): the setting, or the
     * env value it falls back to. Null is no limit, 0 is paused.
     */
    backgroundBudget: number | null
    /** `translation.siteDailyTokens`: every subject's tokens together. Null is no limit. */
    siteBudget: number | null
    maxArticleTokens: number
    translator: boolean
    relay: boolean
    websub: boolean
    assets: boolean
  } | null
  /**
   * The scheduled health check (every fifth minute): when it last ran, and whether the dead-man's
   * switch heard "ok" or `/fail`. Null until one has run.
   */
  health?: { at: number; ok: boolean } | null
}

export type AdminBackup = {
  date: string
  finishedAt: number
  rows: number
  verified: boolean
} | null

/** Leases per kind of work: held now, backing off after a failure, or free to be claimed. */
export type AdminKindLoad = { kind: string; held: number; retrying: number }

export type AdminDeadRow = AdminRowBase & {
  type: 'dead'
  deadId: number
  kind: string
  key: string
  attempts: number
  error: string | null
  at: number
  resolvedAt: number | null
  resolution: 'retried' | 'dismissed' | null
  /** What the key names, for the record panel's link: a feed, site, claim or member. */
  target: { area: 'feeds' | 'sites' | 'claims' | 'people'; id: string; label: string } | null
}

export type AdminLeaseRow = AdminRowBase & {
  type: 'lease'
  kind: string
  key: string
  attempts: number
  notBefore: number
  lastError: string | null
  host: string | null
  target: AdminDeadRow['target']
}

export type AdminSystemRow = AdminDeadRow | AdminLeaseRow

/** The System area's header: the health check and the work it watches. */
export type AdminSystemReport = {
  health: AdminHealth
  heartbeats: AdminHeartbeats
  backup: AdminBackup
  kinds: AdminKindLoad[]
}

export type AdminSystemDetail = { row: AdminSystemRow; history: AdminHistoryEntry[] }

/** One line of the Translation ledger: a blog, a job or a model, over the last 30 days. */
export type AdminTranslationRow = AdminRowBase & {
  kind: 'blog' | 'job' | 'model'
  /** The blog's title (null when untitled), the job's name or the model's. */
  label: string | null
  /** For a blog. */
  siteId: number | null
  homeUrl: string | null
  sourceLang: string | null
  translationOptOut: boolean
  /** For a blog, the languages it was translated into. */
  targets: string[]
  calls: number
  inputTokens: number
  outputTokens: number
  medianLatencyMs: number | null
}

/** The Translation area's header. */
export type AdminTranslationReport = {
  /** Thirty UTC days, oldest first, today last (so far). */
  days: { day: string; title: number; body: number }[]
  totals: { inputTokens: number; outputTokens: number; calls: number }
  /** Tokens no blog can be charged with: title calls that batched several feeds' posts. */
  unattributed: number
  /**
   * Titles' tokens today against the background budget as it holds (ADR 0057): null is no limit
   * and 0 paused. With no setting stored it is tela-jobs' env value, known once a tick has said
   * it (`budgetKnown`).
   */
  background: {
    day: string
    used: number
    reserved: number
    budget: number | null
    budgetKnown: boolean
  }
  /** Every subject's tokens today, members' and titles', against `translation.siteDailyTokens`. */
  site: { day: string; used: number; reserved: number; budget: number | null }
  /** `member.translationsPerDay`: paid body translations a member may ask for a day; null none. */
  memberCap: number | null
  /**
   * How many members reached their day's count this week, so a request of theirs waited. A count,
   * never who: what a member reads is not the console's to show. Operators are exempt and left out.
   */
  nearCap: number
  /** Body translations waiting for the next UTC day now. */
  waiting: number
}

/** The sidebar's badges, `GET /api/v1/admin/counts`: what waits in each queue. */
export type AdminCounts = {
  /** Failed claims not reviewed since. */
  claims: number
  /** Feeds failing or timing out. */
  feeds: number
  /** Unresolved dead letters. */
  dead: number
  /** Blogs members added that wait for review for Discover (ADR 0041). */
  discover: number
}

export type AdminOverview = {
  health: AdminHealth
  queues: {
    claims: { count: number; rows: AdminClaimRow[] }
    feeds: { count: number; rows: AdminFeedRow[] }
    dead: { count: number; rows: AdminDeadRow[] }
    candidates: { count: number; rows: AdminSiteRow[] }
  }
  /** This week against the week before. */
  week: {
    members: [number, number]
    claimsVerified: [number, number]
    feedsAdded: [number, number]
    tokens: [number, number]
  }
  activity: (AdminHistoryEntry & { label: string | null })[]
}

/** One runtime setting as the console's Settings area shows it (ADR 0056). */
export type AdminSettingRow = {
  key: import('../settings').SettingKey
  /** What holds now: the stored value, or the default. */
  value: unknown
  default: unknown
  /** Whether a row overrides the default. */
  stored: boolean
  updatedAt: number | null
}

export type AdminSettings = { settings: AdminSettingRow[] }

/**
 * Reports of public content (ADR 0059): what a member may report, why, and where a report stands.
 * A member reports from the page that shows it; a visitor writes to the contact address.
 */

/**
 * What a report names: a profile (its name, bio, picture), a blogroll, a blog, a note, or an app
 * members connect (ADR 0067).
 */
export const REPORT_TARGETS = ['profile', 'blogroll', 'site', 'recommendation', 'app'] as const
export type ReportTarget = (typeof REPORT_TARGETS)[number]

export const REPORT_REASONS = [
  'spam',
  'abuse',
  'impersonation',
  'copyright',
  'illegal',
  'other',
] as const
export type ReportReason = (typeof REPORT_REASONS)[number]

/** `open` until an operator resolves it (acted on) or dismisses it (nothing to do). */
export const REPORT_STATES = ['open', 'resolved', 'dismissed'] as const
export type ReportState = (typeof REPORT_STATES)[number]

/** The most a reporter may say beside the reason. */
export const REPORT_DETAILS_MAX = 1000

/** Where a visitor, who has no account to report with, writes instead (the Terms' contact). */
export const REPORT_ADDRESS = 'me@hutu.si'

/** A member's account id, as better-auth makes one. */
const ACCOUNT_ID = /^[A-Za-z0-9_-]{8,64}$/
/** A row id written plainly: positive, and no longer than a safe integer's digits. */
const ROW_ID = /^[1-9][0-9]{0,14}$/
/** A blogroll's id, as its member's device mints one (`BLOGROLL_ID`). */
const BLOGROLL_KEY = /^[A-Za-z0-9]{12}$/
/** An app's public `client_id` (`tela_app_…`), the key a report of it names. */
const CLIENT_KEY = /^tela_app_[A-Za-z0-9_-]{8,64}$/

/** What a report's `target_key` names, read. */
export type ReportKey =
  | { kind: 'profile'; userId: string }
  | { kind: 'blogroll'; blogrollId: string }
  | { kind: 'site'; siteId: number }
  | { kind: 'recommendation'; userId: string; articleId: number }
  | { kind: 'app'; clientId: string }

/** A recommendation's key: whose note, on which post (`<userId>:<articleId>`). */
export const recommendationKey = (userId: string, articleId: number) => `${userId}:${articleId}`

/** The key a report names, read for its kind; null for one no target of that kind could have. */
export function reportKeyOf(kind: ReportTarget, key: string): ReportKey | null {
  switch (kind) {
    case 'profile':
      return ACCOUNT_ID.test(key) ? { kind, userId: key } : null
    case 'blogroll':
      return BLOGROLL_KEY.test(key) ? { kind, blogrollId: key } : null
    case 'site':
      return ROW_ID.test(key) && Number.isSafeInteger(Number(key))
        ? { kind, siteId: Number(key) }
        : null
    case 'recommendation': {
      const at = key.lastIndexOf(':')
      const userId = key.slice(0, at)
      const articleId = key.slice(at + 1)
      return at > 0 && ACCOUNT_ID.test(userId) && ROW_ID.test(articleId)
        ? { kind, userId, articleId: Number(articleId) }
        : null
    }
    case 'app':
      return CLIENT_KEY.test(key) ? { kind, clientId: key } : null
    default:
      return null
  }
}

export const isReportTarget = (value: unknown): value is ReportTarget =>
  typeof value === 'string' && (REPORT_TARGETS as readonly string[]).includes(value)

export const isReportReason = (value: unknown): value is ReportReason =>
  typeof value === 'string' && (REPORT_REASONS as readonly string[]).includes(value)

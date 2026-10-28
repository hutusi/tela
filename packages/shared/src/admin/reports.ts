/**
 * Reports in the admin console (ADR 0059). One row per thing reported, however many members
 * reported it: an operator decides about a profile, a blogroll, a blog or a note once, not once per
 * reporter. The row says what the thing is, why it was reported, and what can be done to it now.
 */
import type { ReportReason, ReportState, ReportTarget } from '../reports'
import type { AdminActionName, AdminHistoryEntry, AdminPerson, AdminRowBase } from './common'

/** A row's id: what was reported, as `<kind>:<key>` (`profile:<userId>`, `site:12`, …). */
export function reportRowId(kind: ReportTarget, key: string): string {
  return `${kind}:${key}`
}

/** Whether an account can sign in and be seen (ADRs 0058, 0059). */
export type AdminStanding = 'ok' | 'suspended' | 'deleted'

/** What a report names, as the console shows it. */
export type AdminReportTarget = {
  kind: ReportTarget
  key: string
  /**
   * Its name in words: a member's name or handle, a blogroll's name, a blog's title, a note's
   * text. Null once it is gone.
   */
  label: string | null
  /** The public page that shows it, while one does; null once nothing public shows it. */
  path: string | null
  /**
   * Whose it is: the member, a blogroll's owner, a note's author, an app's developer. Null for a
   * blog, and for an app the operator registered.
   */
  member: (AdminPerson & { standing: AdminStanding }) | null
  /** The blog, for a site. */
  siteId: number | null
  /** The app, for an app (ADR 0067): its id in the Apps area. Its developer is `member`. */
  appId: number | null
  /**
   * What can be done to it now, from the areas that already do it: hide a blog or a blogroll
   * from Discover, cut an app off or end its connections, suspend or delete its member. Each names
   * the target that action takes.
   */
  actions: { action: AdminActionName; id: string }[]
}

export type AdminReportRow = AdminRowBase & {
  target: AdminReportTarget
  state: ReportState
  /** The newest report's reason, and every reason given. */
  reason: ReportReason
  reasons: ReportReason[]
  /** The newest words a reporter gave beside the reason. */
  details: string | null
  /** How many members reported it, in this state. */
  reporters: number
  firstAt: number
  lastAt: number
  /** When an operator resolved or dismissed it, and who; null while open. */
  decidedAt: number | null
  decidedBy: AdminPerson | null
}

/** One member's report of the thing. */
export type AdminReportEntry = {
  id: number
  reason: ReportReason
  details: string | null
  /** The page it was reported from, as the reporter's browser had it. */
  url: string | null
  at: number
  state: ReportState
  /** Null once the reporter's account is gone. */
  reporter: AdminPerson | null
}

export type AdminReportDetail = {
  report: AdminReportRow
  /** Every report of it, in any state, newest first. */
  reports: AdminReportEntry[]
  history: AdminHistoryEntry[]
}

/**
 * Reports of public content (ADR 0059): what a member may report, why, and where a report stands.
 * A member reports from the page that shows it; a visitor writes to the contact address.
 */

/** What a report names: a profile (its name, bio, picture), a blogroll, a blog, or a note. */
export const REPORT_TARGETS = ['profile', 'blogroll', 'site', 'recommendation'] as const
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

/**
 * Reports of public content (ADR 0059). A member names what they saw and why; the operator
 * resolves it in the admin console, with the actions that already act on what it names. Not
 * synced: a report is between its reporter and the operator.
 */
import { REPORT_REASONS, REPORT_STATES, REPORT_TARGETS } from '@tela/shared'
import { sql } from 'drizzle-orm'
import { check, index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { user } from './auth'
import { ms, oneOf } from './columns'

export const reports = sqliteTable(
  'reports',
  {
    id: integer().primaryKey({ autoIncrement: true }),
    reporterId: text().references(() => user.id, { onDelete: 'set null' }),
    targetKind: text({ enum: REPORT_TARGETS }).notNull(),
    /** A user id, blogroll id, site id, or `<userId>:<articleId>` for a recommendation's note. */
    targetKey: text().notNull(),
    reason: text({ enum: REPORT_REASONS }).notNull(),
    details: text(),
    /** The page it was reported from, as the reporter's browser had it. */
    url: text(),
    state: text({ enum: REPORT_STATES }).notNull().default('open'),
    createdAt: ms().notNull(),
    resolvedAt: ms(),
    resolvedBy: text().references(() => user.id, { onDelete: 'set null' }),
  },
  (t) => [
    check('reports_target_kind_check', oneOf(t.targetKind, REPORT_TARGETS)),
    check('reports_reason_check', oneOf(t.reason, REPORT_REASONS)),
    check('reports_state_check', oneOf(t.state, REPORT_STATES)),
    check('reports_details_check', sql`${t.details} is null or length(${t.details}) <= 1000`),
    index('reports_state_created_idx').on(t.state, t.createdAt),
    index('reports_target_idx').on(t.targetKind, t.targetKey),
    index('reports_reporter_idx').on(t.reporterId, t.createdAt),
  ],
)

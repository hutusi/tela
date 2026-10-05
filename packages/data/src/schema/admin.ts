/**
 * What operators did in the admin console (ADR 0039). One row per target an action touched,
 * written in the same batch as the change: an `insert … select` reads the value it replaces in that
 * snapshot, so `detail` holds `{from, to}` exactly, and an undo restores `from` only while the row
 * still holds `to`. A bulk action shares one `group_id`, which is also the undo token. Not synced,
 * and never an email address: an invitation is named by its redemption id.
 */
import { sql } from 'drizzle-orm'
import { check, index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { user } from './auth'
import { ms } from './columns'

export const adminActions = sqliteTable(
  'admin_actions',
  {
    id: integer().primaryKey({ autoIncrement: true }),
    groupId: text().notNull(),
    actorId: text().references(() => user.id, { onDelete: 'set null' }),
    action: text().notNull(),
    targetKind: text().notNull(),
    targetKey: text().notNull(),
    detail: text().notNull().default('{}'),
    at: ms().notNull(),
  },
  (t) => [
    check('admin_actions_detail_check', sql`json_valid(${t.detail})`),
    index('admin_actions_at_idx').on(t.at),
    index('admin_actions_target_idx').on(t.targetKind, t.targetKey, t.at),
    index('admin_actions_group_idx').on(t.groupId),
  ],
)

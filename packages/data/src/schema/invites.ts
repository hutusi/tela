/**
 * Invite codes and what was done with them (ADR 0034). Neither table syncs: a member's codes are
 * an RPC answer, and a redemption names other people. A code never references its redemptions,
 * so the nightly export, which orders tables by their foreign keys, has an order to follow.
 */
import { sql } from 'drizzle-orm'
import { check, index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'
import { user } from './auth'
import { ms } from './columns'

/**
 * A code, stored normalized (`normalizeInviteCode` in `@tela/shared`). A member's is drawn by
 * tela-api and admits one person; the operator's (`created_by` null) is text of their choosing
 * with as many places as they give it. Revoking stops it admitting anyone else.
 */
export const inviteCodes = sqliteTable(
  'invite_codes',
  {
    code: text().primaryKey(),
    createdBy: text().references(() => user.id, { onDelete: 'cascade' }),
    maxUses: integer().notNull().default(1),
    createdAt: ms().notNull(),
    revokedAt: ms(),
  },
  (t) => [
    check(
      'invite_codes_code_check',
      sql`length(${t.code}) between 4 and 32 and ${t.code} not glob '*[^A-Z0-9]*'`,
    ),
    check('invite_codes_max_uses_check', sql`${t.maxUses} between 1 and 100000`),
    index('invite_codes_created_by_idx').on(t.createdBy),
  ],
)

/**
 * An address beside a code. Until `redeemed_at` it is a hold: someone asked to join with this
 * address, and it lapses at `expires_at` without taking a place. A redeemed row is a place, spent
 * for good. Once the account exists the row is settled: `user_id` is the member it made, and
 * `settled_at` when. A claimed row not yet settled is one whose account was never made, and it
 * admits the same address again; `user_id` alone cannot say so, since it goes null when the
 * member is deleted, and a deleted member must not be let back in by it. `code` is null for the
 * operator's invitation to one address (`bun run admin invite`), so the unique index, under
 * which nulls are distinct, never merges two of those.
 */
export const inviteRedemptions = sqliteTable(
  'invite_redemptions',
  {
    id: integer().primaryKey({ autoIncrement: true }),
    code: text().references(() => inviteCodes.code, { onDelete: 'cascade' }),
    /** Lowercased, as better-auth stores `user.email`. */
    email: text().notNull(),
    expiresAt: ms().notNull(),
    redeemedAt: ms(),
    userId: text().references(() => user.id, { onDelete: 'set null' }),
    settledAt: ms(),
    createdAt: ms().notNull(),
  },
  (t) => [
    uniqueIndex('invite_redemptions_code_email_idx').on(t.code, t.email),
    index('invite_redemptions_email_idx').on(t.email),
    // A code's places are its redeemed rows: counted on every join and every claim.
    index('invite_redemptions_code_redeemed_idx').on(t.code, t.redeemedAt),
    index('invite_redemptions_user_idx').on(t.userId),
  ],
)

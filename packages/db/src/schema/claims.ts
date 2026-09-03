import { sql } from 'drizzle-orm'
import {
  bigint,
  index,
  integer,
  pgPolicy,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core'
import { authenticatedRole, authUid } from 'drizzle-orm/supabase'
import { articles } from './articles'
import { claimMethodEnum, claimStatusEnum } from './enums'
import { profiles } from './profiles'
import { sites } from './sites'

/** A user's attempt to prove they own a site. Verified by the claim worker role. */
export const siteClaims = pgTable(
  'site_claims',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    siteId: bigint('site_id', { mode: 'number' })
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    method: claimMethodEnum('method').notNull(),
    token: text('token').notNull(),
    status: claimStatusEnum('status').notNull().default('pending'),
    lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }),
    error: text('error'),
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('site_claims_site_id_idx').on(t.siteId),
    index('site_claims_user_id_idx').on(t.userId),
    pgPolicy('site_claims_select_own', {
      for: 'select',
      to: authenticatedRole,
      using: sql`${authUid} = ${t.userId}`,
    }),
  ],
)

/** One row per LLM call. Service-only; RLS enabled with no policies. */
export const llmUsage = pgTable(
  'llm_usage',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    job: text('job').notNull(),
    articleId: bigint('article_id', { mode: 'number' }).references(() => articles.id, {
      onDelete: 'set null',
    }),
    targetLang: text('target_lang'),
    model: text('model').notNull(),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    latencyMs: integer('latency_ms'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('llm_usage_created_at_idx').on(t.createdAt)],
).enableRLS()

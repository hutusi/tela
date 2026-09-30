/** What translation costs: one row per provider call, and a daily ledger members reserve against. */
import { index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { articles } from './articles'
import { user } from './auth'
import { ms } from './columns'

export const llmCalls = sqliteTable(
  'llm_calls',
  {
    id: integer().primaryKey({ autoIncrement: true }),
    job: text().notNull(),
    contentKey: text(),
    articleId: integer().references(() => articles.id, { onDelete: 'set null' }),
    targetLang: text(),
    userId: text().references(() => user.id, { onDelete: 'set null' }),
    model: text().notNull(),
    inputTokens: integer().notNull(),
    outputTokens: integer().notNull(),
    latencyMs: integer().notNull(),
    createdAt: ms().notNull(),
  },
  (t) => [
    index('llm_calls_created_idx').on(t.createdAt),
    index('llm_calls_user_created_idx').on(t.userId, t.createdAt),
  ],
)

/**
 * Tokens reserved and used per subject per UTC day. A member's subject is their user id; the
 * background budget is `'*'`. A reservation is one conditional upsert here, so no advisory lock
 * is needed (ADR 0021).
 */
export const usageDaily = sqliteTable(
  'usage_daily',
  {
    subject: text().notNull(),
    day: text().notNull(),
    reserved: integer().notNull().default(0),
    used: integer().notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.subject, t.day] })],
)

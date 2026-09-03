import { RECOMMENDATION_NOTE_MAX } from '@tela/shared'
import { sql } from 'drizzle-orm'
import {
  bigint,
  check,
  index,
  pgPolicy,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { anonRole, authenticatedRole, authUid } from 'drizzle-orm/supabase'
import { articles } from './articles'
import { feeds } from './feeds'
import { profiles } from './profiles'

/** watermark_id: every article with id <= watermark counts as read ("mark all read"). */
export const subscriptions = pgTable(
  'subscriptions',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    feedId: bigint('feed_id', { mode: 'number' })
      .notNull()
      .references(() => feeds.id, { onDelete: 'cascade' }),
    watermarkId: bigint('watermark_id', { mode: 'number' }).notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.feedId] }),
    index('subscriptions_feed_id_idx').on(t.feedId),
    pgPolicy('subscriptions_own', {
      for: 'all',
      to: authenticatedRole,
      using: sql`${authUid} = ${t.userId}`,
      withCheck: sql`${authUid} = ${t.userId}`,
    }),
  ],
)

/** Read and like state. Rows with only read_at below the watermark are compacted away. */
export const userArticleStates = pgTable(
  'user_article_states',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    articleId: bigint('article_id', { mode: 'number' })
      .notNull()
      .references(() => articles.id, { onDelete: 'cascade' }),
    readAt: timestamp('read_at', { withTimezone: true }),
    likedAt: timestamp('liked_at', { withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.articleId] }),
    index('user_article_states_liked_idx').on(t.userId, t.likedAt.desc()),
    pgPolicy('user_article_states_own', {
      for: 'all',
      to: authenticatedRole,
      using: sql`${authUid} = ${t.userId}`,
      withCheck: sql`${authUid} = ${t.userId}`,
    }),
  ],
)

/** Public recommendation with an optional note; visible on the profile and to the author. */
export const recommendations = pgTable(
  'recommendations',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    userId: uuid('user_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    articleId: bigint('article_id', { mode: 'number' })
      .notNull()
      .references(() => articles.id, { onDelete: 'cascade' }),
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('recommendations_user_article_key').on(t.userId, t.articleId),
    index('recommendations_article_id_idx').on(t.articleId),
    index('recommendations_user_created_idx').on(t.userId, t.createdAt.desc()),
    check(
      'recommendations_note_length',
      sql`char_length(${t.note}) <= ${sql.raw(String(RECOMMENDATION_NOTE_MAX))}`,
    ),
    pgPolicy('recommendations_select_public', {
      for: 'select',
      to: [anonRole, authenticatedRole],
      using: sql`true`,
    }),
    pgPolicy('recommendations_insert_own', {
      for: 'insert',
      to: authenticatedRole,
      withCheck: sql`${authUid} = ${t.userId}`,
    }),
    pgPolicy('recommendations_update_own', {
      for: 'update',
      to: authenticatedRole,
      using: sql`${authUid} = ${t.userId}`,
      withCheck: sql`${authUid} = ${t.userId}`,
    }),
    pgPolicy('recommendations_delete_own', {
      for: 'delete',
      to: authenticatedRole,
      using: sql`${authUid} = ${t.userId}`,
    }),
  ],
)

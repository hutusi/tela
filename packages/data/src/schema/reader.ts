/**
 * What each member has done: subscriptions, read and liked state, highlights, recommendations,
 * the members they follow.
 * All of it syncs to the reader's device, so every row carries `seq`, and removals are soft
 * (`deleted_at`) so a pull can see them.
 */
import { sql } from 'drizzle-orm'
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core'
import { articles } from './articles'
import { user } from './auth'
import { ms, oneOf, seq } from './columns'
import { feeds } from './sources'
import { HIGHLIGHT_SIDES } from './values'

export const subscriptions = sqliteTable(
  'subscriptions',
  {
    userId: text()
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    feedId: integer()
      .notNull()
      .references(() => feeds.id, { onDelete: 'cascade' }),
    /** Everything at or below this article id is read (ADR 0009). */
    watermarkId: integer().notNull().default(0),
    createdAt: ms().notNull(),
    updatedAt: ms().notNull(),
    deletedAt: ms(),
    seq: seq(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.feedId] }),
    index('subscriptions_feed_idx').on(t.feedId),
    index('subscriptions_user_seq_idx').on(t.userId, t.seq),
  ],
)

export const userArticleStates = sqliteTable(
  'user_article_states',
  {
    userId: text()
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    articleId: integer()
      .notNull()
      .references(() => articles.id, { onDelete: 'cascade' }),
    readAt: ms(),
    /**
     * When the member last chose read or unread by hand, null until they first mark it unread. A
     * row with no `read_at` and this set is marked unread: it beats the feed's watermark, and
     * compaction keeps it, until a later read (ADR 0009).
     */
    readUpdatedAt: ms(),
    likedAt: ms(),
    /** When the liked flag last changed; last writer wins across devices. */
    likedUpdatedAt: ms(),
    seq: seq(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.articleId] }),
    index('user_article_states_user_seq_idx').on(t.userId, t.seq),
    index('user_article_states_user_liked_idx').on(t.userId, t.likedAt),
  ],
)

/**
 * A highlight, anchored to one leaf block of one content version: the leaf's `data-tb` id,
 * offsets into its text, and the quoted text with context so it can be found again in a later
 * version. `id` is minted by the client, so a replayed push cannot duplicate it.
 */
export const highlights = sqliteTable(
  'highlights',
  {
    id: text().primaryKey(),
    userId: text()
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    articleId: integer()
      .notNull()
      .references(() => articles.id, { onDelete: 'cascade' }),
    contentKey: text().notNull(),
    side: text({ enum: HIGHLIGHT_SIDES }).notNull(),
    /** Target language when made on the translation side. */
    lang: text(),
    leafId: text().notNull(),
    start: integer().notNull(),
    end: integer().notNull(),
    quote: text().notNull(),
    prefix: text().notNull().default(''),
    suffix: text().notNull().default(''),
    note: text(),
    color: text(),
    createdAt: ms().notNull(),
    updatedAt: ms().notNull(),
    deletedAt: ms(),
    seq: seq(),
  },
  (t) => [
    check('highlights_side_check', oneOf(t.side, HIGHLIGHT_SIDES)),
    check('highlights_range_check', sql`${t.start} >= 0 and ${t.end} > ${t.start}`),
    check('highlights_note_check', sql`${t.note} is null or length(${t.note}) <= 2000`),
    index('highlights_user_seq_idx').on(t.userId, t.seq),
    index('highlights_user_article_idx').on(t.userId, t.articleId),
  ],
)

export const recommendations = sqliteTable(
  'recommendations',
  {
    id: integer().primaryKey({ autoIncrement: true }),
    userId: text()
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    articleId: integer()
      .notNull()
      .references(() => articles.id, { onDelete: 'cascade' }),
    note: text(),
    createdAt: ms().notNull(),
    updatedAt: ms().notNull(),
    deletedAt: ms(),
    seq: seq(),
  },
  (t) => [
    check('recommendations_note_check', sql`${t.note} is null or length(${t.note}) <= 500`),
    uniqueIndex('recommendations_user_article_idx').on(t.userId, t.articleId),
    index('recommendations_article_idx').on(t.articleId),
    index('recommendations_user_seq_idx').on(t.userId, t.seq),
    /** The week's recommendations, for Discover's This week and Articles (ADR 0044). */
    index('recommendations_created_idx').on(t.createdAt),
  ],
)

/**
 * One member following another (ADR 0031): one-way, public, with no approval. The row syncs to
 * the follower only, and an unfollow is soft so a pull can see it. The check is a backstop: a
 * push excludes a self-follow in its own `where`, because a violated check would sink the batch.
 */
export const follows = sqliteTable(
  'follows',
  {
    followerId: text()
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    followeeId: text()
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    createdAt: ms().notNull(),
    /** When the follow last changed; last writer wins across devices. */
    updatedAt: ms().notNull(),
    deletedAt: ms(),
    seq: seq(),
  },
  (t) => [
    primaryKey({ columns: [t.followerId, t.followeeId] }),
    check('follows_not_self_check', sql`${t.followerId} <> ${t.followeeId}`),
    index('follows_follower_seq_idx').on(t.followerId, t.seq),
    index('follows_followee_idx').on(t.followeeId, t.deletedAt),
  ],
)

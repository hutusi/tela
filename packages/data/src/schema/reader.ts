/**
 * What each member has done: subscriptions and the folders they are in, read and liked state,
 * highlights, recommendations, the members they follow, the blogrolls they keep.
 * All of it syncs to the reader's device, so every row carries `seq`, and removals are soft
 * (`deleted_at`) so a pull can see them.
 */
import {
  BLOGROLL_DESCRIPTION_MAX,
  BLOGROLL_NAME_MAX,
  BLOGROLL_NOTE_MAX,
  FOLDER_NAME_MAX,
} from '@tela/shared'
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
import { flag, ms, oneOf, seq } from './columns'
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
 * A folder of the member's subscriptions (ADR 0048), private to them. `id` is minted by the
 * client, as a highlight's is. A deleted folder stays deleted: a rename from another device never
 * brings it back.
 */
export const folders = sqliteTable(
  'folders',
  {
    id: text().primaryKey(),
    userId: text()
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    name: text().notNull(),
    createdAt: ms().notNull(),
    updatedAt: ms().notNull(),
    deletedAt: ms(),
    seq: seq(),
  },
  (t) => [
    check(
      'folders_name_check',
      sql`length(${t.name}) between 1 and ${sql.raw(String(FOLDER_NAME_MAX))}`,
    ),
    index('folders_user_seq_idx').on(t.userId, t.seq),
  ],
)

/**
 * Which folder a blog is in, one at most (ADR 0048): a row of its own rather than a column on the
 * subscription, because a subscription's seq moving sends its feed's whole horizon again. Null is
 * no folder. The row outlives an unsubscribe, so subscribing again puts the blog back where it was.
 */
export const feedFolders = sqliteTable(
  'feed_folders',
  {
    userId: text()
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    feedId: integer()
      .notNull()
      .references(() => feeds.id, { onDelete: 'cascade' }),
    folderId: text().references(() => folders.id, { onDelete: 'set null' }),
    /** When the member last moved it; the later `at` wins across devices. */
    updatedAt: ms().notNull(),
    seq: seq(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.feedId] }),
    index('feed_folders_user_seq_idx').on(t.userId, t.seq),
    index('feed_folders_folder_idx').on(t.folderId),
  ],
)

/**
 * A member's blogroll (ADR 0050): a list of blogs to share, private until its member makes it
 * public. `id` is minted by the client and is the blogroll's address (`/l/<id>`). The row syncs to
 * its member only; others read a public one through tela-api.
 *
 * `updated_at` is the clock of the name and description. Public or private has a version of its
 * own (`public_version`), as the profile's privacy switches do (issue #16), so a stale device's
 * rename never makes public again what another device made private. `public_since` is when it
 * first went public, set by tela-api and never cleared: Discover pages by it. `hidden_at` is the
 * operator's Hide from Discover; it never syncs and never moves `seq` or `updated_at`.
 */
export const blogrolls = sqliteTable(
  'blogrolls',
  {
    id: text().primaryKey(),
    userId: text()
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    name: text().notNull(),
    description: text().notNull().default(''),
    isPublic: flag(),
    publicVersion: integer().notNull().default(0),
    publicSince: ms(),
    hiddenAt: ms(),
    createdAt: ms().notNull(),
    updatedAt: ms().notNull(),
    deletedAt: ms(),
    seq: seq(),
  },
  (t) => [
    check(
      'blogrolls_name_check',
      sql`length(${t.name}) between 1 and ${sql.raw(String(BLOGROLL_NAME_MAX))}`,
    ),
    check(
      'blogrolls_description_check',
      sql`length(${t.description}) <= ${sql.raw(String(BLOGROLL_DESCRIPTION_MAX))}`,
    ),
    index('blogrolls_user_seq_idx').on(t.userId, t.seq),
    index('blogrolls_discover_idx').on(t.isPublic, t.publicSince, t.id),
  ],
)

/**
 * A blog in a blogroll, with its member's note (ADR 0050). Keyed by feed, as a subscription and a
 * filing are, so a merged address resolves through `feeds.merged_into`. A removal is soft, so a
 * pull sees it, and a blog put back goes to the end (`added_at`). The note keeps its own clock
 * (`note_at`) and outlives a removal, so a note written on one device never brings back a blog
 * another device removed. Unsubscribing never touches this row: a blogroll recommends blogs, it
 * does not mirror subscriptions.
 */
export const blogrollBlogs = sqliteTable(
  'blogroll_blogs',
  {
    blogrollId: text()
      .notNull()
      .references(() => blogrolls.id, { onDelete: 'cascade' }),
    feedId: integer()
      .notNull()
      .references(() => feeds.id, { onDelete: 'cascade' }),
    userId: text()
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    note: text(),
    /** When the note last changed; the later `at` wins. 0 for never written. */
    noteAt: ms().notNull().default(0),
    /** When the blog was put in (again): the blogroll's order. */
    addedAt: ms().notNull(),
    /** When the blog was last put in or taken out; the later `at` wins. */
    updatedAt: ms().notNull(),
    removedAt: ms(),
    seq: seq(),
  },
  (t) => [
    primaryKey({ columns: [t.blogrollId, t.feedId] }),
    check(
      'blogroll_blogs_note_check',
      sql`${t.note} is null or length(${t.note}) between 1 and ${sql.raw(String(BLOGROLL_NOTE_MAX))}`,
    ),
    index('blogroll_blogs_user_seq_idx').on(t.userId, t.seq),
    index('blogroll_blogs_feed_idx').on(t.feedId),
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

/**
 * Feeds an import named that were new to Tela beyond the member's day (ADR 0057): kept here and
 * added on the days after, at most `member.feedsPerDay` a day, by `member.pendingFeeds`. Not
 * synced; the member's usage answer says how many wait.
 */
export const pendingFeeds = sqliteTable(
  'pending_feeds',
  {
    userId: text()
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    feedUrl: text().notNull(),
    title: text(),
    queuedAt: ms().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.feedUrl] }),
    index('pending_feeds_queued_idx').on(t.queuedAt),
  ],
)

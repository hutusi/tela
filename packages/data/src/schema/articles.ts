/**
 * Articles, the versions of their bodies, and their translations. Bodies themselves are immutable
 * content objects in blob storage (`c/<contentKey>.json`); these rows say which object is current
 * and where each version came from.
 */

import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core'
import { user } from './auth'
import { ms, oneOf, seq, validJson } from './columns'
import { feeds } from './sources'
import { BODY_TRANSLATION_STATES, EXTRACT_STATES, PROVENANCES, TITLE_STATUSES } from './values'

export const articles = sqliteTable(
  'articles',
  {
    /**
     * Ingest order. AUTOINCREMENT, not a bare rowid: a rowid can reuse a deleted maximum, and the
     * unread watermark (ADR 0009) needs ids that only ever grow.
     */
    id: integer().primaryKey({ autoIncrement: true }),
    feedId: integer()
      .notNull()
      .references(() => feeds.id, { onDelete: 'cascade' }),
    dedupKey: text().notNull(),
    url: text(),
    /** Host of `url`, for per-host politeness when the extraction sweep fetches the page. */
    urlHost: text(),
    title: text().notNull().default(''),
    author: text(),
    publishedAt: ms(),
    fetchedAt: ms().notNull(),
    /** coalesce(published_at, fetched_at), stored so the list sorts on an index. */
    sortAt: ms().notNull(),
    sourceLang: text(),
    excerpt: text(),
    /** The version readers see now, and its content object's key. Null until the first version. */
    currentVersion: integer(),
    contentKey: text(),
    wordCount: integer().notNull().default(0),
    readingMinutes: integer().notNull().default(0),
    extractState: text({ enum: EXTRACT_STATES }).notNull().default('none'),
    /**
     * Hash of the title and excerpt readers see now. A title translation made from another hash is
     * stale, which is how the title sweep finds work without a queue (ADR 0021).
     */
    titleHash: text(),
    likeCount: integer().notNull().default(0),
    recommendCount: integer().notNull().default(0),
    seq: seq(),
  },
  (t) => [
    check('articles_extract_state_check', oneOf(t.extractState, EXTRACT_STATES)),
    uniqueIndex('articles_feed_dedup_idx').on(t.feedId, t.dedupKey),
    index('articles_feed_seq_idx').on(t.feedId, t.seq),
    index('articles_feed_sort_idx').on(t.feedId, t.sortAt, t.id),
    /**
     * Every public post newest first, across feeds: Discover's Articles pages by `(sort_at, id)`
     * (ADR 0044). `articles_feed_sort_idx` serves one feed's newest, not the whole directory's.
     */
    index('articles_sort_idx').on(t.sortAt, t.id),
    index('articles_content_key_idx').on(t.contentKey),
    index('articles_fetched_at_idx').on(t.fetchedAt),
    index('articles_extract_state_idx').on(t.extractState, t.fetchedAt),
  ],
)

/**
 * Every body an article has had. Versions are never rewritten: a changed feed item or a successful
 * extraction adds one, and `chooseCurrent` decides which is current. Highlights keep pointing at
 * the version they were made on.
 */
export const articleVersions = sqliteTable(
  'article_versions',
  {
    articleId: integer()
      .notNull()
      .references(() => articles.id, { onDelete: 'cascade' }),
    version: integer().notNull(),
    provenance: text({ enum: PROVENANCES }).notNull(),
    contentKey: text().notNull(),
    /** The raw item HTML (`r/<sha>.html`), so a NORM_VERSION bump can replay the pipeline. */
    rawKey: text(),
    normVersion: integer().notNull(),
    bodyChars: integer().notNull(),
    /** What the article shows when this version is current. */
    excerpt: text(),
    wordCount: integer().notNull().default(0),
    readingMinutes: integer().notNull().default(0),
    lang: text(),
    sourceUrl: text(),
    createdAt: ms().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.articleId, t.version] }),
    check('article_versions_provenance_check', oneOf(t.provenance, PROVENANCES)),
    index('article_versions_content_key_idx').on(t.contentKey),
  ],
)

/** Eager title (and excerpt) translations, one per article and reading language. */
export const articleTitles = sqliteTable(
  'article_titles',
  {
    articleId: integer()
      .notNull()
      .references(() => articles.id, { onDelete: 'cascade' }),
    lang: text().notNull(),
    /** Denormalized so a feed-scoped sync pull reads titles by (feed_id, seq). */
    feedId: integer().notNull(),
    title: text(),
    excerpt: text(),
    status: text({ enum: TITLE_STATUSES }).notNull(),
    /** The article's title_hash this was translated from; a different current hash means stale. */
    sourceHash: text().notNull(),
    model: text(),
    updatedAt: ms().notNull(),
    seq: seq(),
  },
  (t) => [
    primaryKey({ columns: [t.articleId, t.lang] }),
    check('article_titles_status_check', oneOf(t.status, TITLE_STATUSES)),
    index('article_titles_feed_seq_idx').on(t.feedId, t.seq),
  ],
)

/**
 * The content-addressed translation cache (ADR 0005): one row per source block hash, target and
 * source language, holding translated tagged text. First write wins.
 */
export const blockTranslations = sqliteTable(
  'block_translations',
  {
    sourceHash: text().notNull(),
    targetLang: text().notNull(),
    sourceLang: text().notNull().default('und'),
    taggedText: text().notNull(),
    model: text().notNull(),
    normVersion: integer().notNull(),
    createdAt: ms().notNull(),
  },
  (t) => [primaryKey({ columns: [t.sourceHash, t.targetLang, t.sourceLang] })],
)

/**
 * A body translation of one content version into one language. Keyed by content, not article:
 * two articles with the same body share it. While running, `chunkKeys` lists the chunk objects
 * the reader overlays as they land; `objectKey` is the finished translation object.
 */
export const bodyTranslations = sqliteTable(
  'body_translations',
  {
    contentKey: text().notNull(),
    lang: text().notNull(),
    state: text({ enum: BODY_TRANSLATION_STATES }).notNull(),
    requestId: text(),
    requestedBy: text().references(() => user.id, { onDelete: 'set null' }),
    reservedTokens: integer().notNull().default(0),
    /**
     * Tokens this request has spent so far, across every execution that continued it. What the
     * member's reservation is reconciled against when it concludes.
     */
    usedTokens: integer().notNull().default(0),
    /** UTC day (YYYY-MM-DD) the reservation was charged to, so completion reconciles that day. */
    reservedDay: text(),
    chunkKeys: text().notNull().default('[]'),
    objectKey: text(),
    failedLeaves: text().notNull().default('[]'),
    model: text(),
    updatedAt: ms().notNull(),
    seq: seq(),
  },
  (t) => [
    primaryKey({ columns: [t.contentKey, t.lang] }),
    check('body_translations_state_check', oneOf(t.state, BODY_TRANSLATION_STATES)),
    check('body_translations_chunk_keys_check', validJson(t.chunkKeys)),
    check('body_translations_failed_leaves_check', validJson(t.failedLeaves)),
    index('body_translations_state_idx').on(t.state),
    index('body_translations_seq_idx').on(t.seq),
  ],
)

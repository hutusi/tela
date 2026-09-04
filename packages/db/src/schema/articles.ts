import { sql } from 'drizzle-orm'
import {
  bigint,
  index,
  integer,
  jsonb,
  pgPolicy,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core'
import { anonRole, authenticatedRole } from 'drizzle-orm/supabase'
import { extractedFromEnum, translationStatusEnum } from './enums'
import { feeds } from './feeds'

/**
 * Article metadata. bigint ids give ingest order, which the unread watermark relies on.
 * dedup_key comes from the dedup ladder (guid → normalized link → sha(title|published_at)).
 */
export const articles = pgTable(
  'articles',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    feedId: bigint('feed_id', { mode: 'number' })
      .notNull()
      .references(() => feeds.id, { onDelete: 'cascade' }),
    dedupKey: text('dedup_key').notNull(),
    url: text('url'),
    title: text('title').notNull().default(''),
    author: text('author'),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
    sourceLang: text('source_lang'),
    excerpt: text('excerpt'),
    contentHash: text('content_hash'),
    contentVersion: integer('content_version').notNull().default(1),
    wordCount: integer('word_count'),
    readingMinutes: integer('reading_minutes'),
    likeCount: integer('like_count').notNull().default(0),
    recommendCount: integer('recommend_count').notNull().default(0),
  },
  (t) => [
    uniqueIndex('articles_feed_dedup_key').on(t.feedId, t.dedupKey),
    index('articles_feed_id_id_idx').on(t.feedId, t.id.desc()),
    index('articles_feed_published_idx').on(t.feedId, t.publishedAt.desc()),
    pgPolicy('articles_select_public', {
      for: 'select',
      to: anonRole,
      using: sql`exists (select 1 from feeds f join sites s on s.id = f.site_id where f.id = ${t.feedId} and s.listing in ('listed', 'featured'))`,
    }),
    pgPolicy('articles_select_member', {
      for: 'select',
      to: authenticatedRole,
      using: sql`true`,
    }),
  ],
)

/** One block summary entry, mirrored from the data-tb attributes in html. */
export type BlockSummary = {
  /** data-tb value: first 10 hex of the hash, with -2/-3 suffixes for duplicates. */
  id: string
  /** Full content hash of the tagged text; key into the translations table. */
  hash: string
  tag: string
  chars: number
  skip?: boolean
}

export const articleContents = pgTable(
  'article_contents',
  {
    articleId: bigint('article_id', { mode: 'number' })
      .primaryKey()
      .references(() => articles.id, { onDelete: 'cascade' }),
    html: text('html').notNull(),
    blocks: jsonb('blocks').$type<BlockSummary[]>().notNull().default(sql`'[]'::jsonb`),
    extractedFrom: extractedFromEnum('extracted_from').notNull().default('feed'),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    pgPolicy('article_contents_select_public', {
      for: 'select',
      to: anonRole,
      using: sql`exists (select 1 from articles a join feeds f on f.id = a.feed_id join sites s on s.id = f.site_id where a.id = ${t.articleId} and s.listing in ('listed', 'featured'))`,
    }),
    pgPolicy('article_contents_select_member', {
      for: 'select',
      to: authenticatedRole,
      using: sql`true`,
    }),
  ],
)

/**
 * Content-addressed translation cache. Keyed by the block's tagged-text hash and the
 * target language, so identical paragraphs across articles and versions cost once.
 */
export const translations = pgTable(
  'translations',
  {
    sourceHash: text('source_hash').notNull(),
    targetLang: text('target_lang').notNull(),
    taggedText: text('tagged_text').notNull(),
    sourceLangHint: text('source_lang_hint'),
    model: text('model').notNull(),
    normVersion: integer('norm_version').notNull(),
    chars: integer('chars'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.sourceHash, t.targetLang] }),
    pgPolicy('translations_select_public', {
      for: 'select',
      to: [anonRole, authenticatedRole],
      using: sql`true`,
    }),
  ],
)

/** Per-article materialized translation state and rehydrated html. */
export const articleTranslations = pgTable(
  'article_translations',
  {
    articleId: bigint('article_id', { mode: 'number' })
      .notNull()
      .references(() => articles.id, { onDelete: 'cascade' }),
    targetLang: text('target_lang').notNull(),
    contentHash: text('content_hash'),
    status: translationStatusEnum('status').notNull().default('pending'),
    title: text('title'),
    excerpt: text('excerpt'),
    html: text('html'),
    failedBlockIds: text('failed_block_ids').array().notNull().default(sql`'{}'::text[]`),
    model: text('model'),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    primaryKey({ columns: [t.articleId, t.targetLang] }),
    index('article_translations_status_idx').on(t.status),
    pgPolicy('article_translations_select_public', {
      for: 'select',
      to: anonRole,
      using: sql`exists (select 1 from articles a join feeds f on f.id = a.feed_id join sites s on s.id = f.site_id where a.id = ${t.articleId} and s.listing in ('listed', 'featured'))`,
    }),
    pgPolicy('article_translations_select_member', {
      for: 'select',
      to: authenticatedRole,
      using: sql`true`,
    }),
  ],
)

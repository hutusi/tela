import type { TranslationStatus } from '@tela/shared'
import { and, eq, inArray, sql } from 'drizzle-orm'
import type { Db, Tx } from '../client'
import { articleTranslations, profiles, translations } from '../schema'

/** The cache key's source-language component: articles with no detected language share 'und'. */
export function cacheSourceLang(sourceLang: string | null | undefined): string {
  return sourceLang ?? 'und'
}

/** Cached translations for a set of block hashes: hash → translated tagged text. */
export async function getCachedTranslations(
  db: Db,
  hashes: string[],
  targetLang: string,
  sourceLang: string | null,
): Promise<Map<string, string>> {
  if (hashes.length === 0) return new Map()
  const rows = await db
    .select({ hash: translations.sourceHash, text: translations.taggedText })
    .from(translations)
    .where(
      and(
        eq(translations.targetLang, targetLang),
        eq(translations.sourceLang, cacheSourceLang(sourceLang)),
        inArray(translations.sourceHash, hashes),
      ),
    )
  return new Map(rows.map((r) => [r.hash, r.text]))
}

export type CacheEntry = {
  sourceHash: string
  targetLang: string
  taggedText: string
  sourceLang: string | null
  model: string
  normVersion: number
  chars: number
}

/** Store validated translations; existing entries win (first translation stays). */
export async function storeTranslations(db: Db, entries: CacheEntry[]): Promise<void> {
  if (entries.length === 0) return
  await db
    .insert(translations)
    .values(
      entries.map((e) => ({
        sourceHash: e.sourceHash,
        targetLang: e.targetLang,
        sourceLang: cacheSourceLang(e.sourceLang),
        taggedText: e.taggedText,
        model: e.model,
        normVersion: e.normVersion,
        chars: e.chars,
      })),
    )
    .onConflictDoNothing()
}

export type ArticleTranslationRow = typeof articleTranslations.$inferSelect

export async function getArticleTranslation(
  db: Db,
  articleId: number,
  targetLang: string,
): Promise<ArticleTranslationRow | null> {
  const [row] = await db
    .select()
    .from(articleTranslations)
    .where(
      and(
        eq(articleTranslations.articleId, articleId),
        eq(articleTranslations.targetLang, targetLang),
      ),
    )
  return row ?? null
}

export type RequestOutcome = 'requested' | 'in_progress' | 'ready'

/**
 * Ask for a body translation. Returns 'ready' when a fresh translation exists,
 * 'in_progress' when one is already queued or running, and 'requested' when this call
 * created the request. Pass `enqueue` to insert the translate.body job inside the same
 * transaction: it runs after the status write and before commit, so a failure to enqueue
 * rolls the `requested` status back instead of stranding a row no worker will ever pick up.
 */
export async function requestBodyTranslation(
  db: Db,
  articleId: number,
  targetLang: string,
  contentHash: string | null,
  enqueue?: (tx: Tx) => Promise<void>,
): Promise<RequestOutcome> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ status: articleTranslations.status, contentHash: articleTranslations.contentHash })
      .from(articleTranslations)
      .where(
        and(
          eq(articleTranslations.articleId, articleId),
          eq(articleTranslations.targetLang, targetLang),
        ),
      )
      .for('update')
    const fresh = row !== undefined && row.contentHash === contentHash
    if (fresh && (row.status === 'done' || row.status === 'partial')) return 'ready'
    if (fresh && (row.status === 'requested' || row.status === 'running')) return 'in_progress'
    await tx
      .insert(articleTranslations)
      .values({ articleId, targetLang, contentHash, status: 'requested' })
      .onConflictDoUpdate({
        target: [articleTranslations.articleId, articleTranslations.targetLang],
        // The old html belongs to the previous content version; it must not show as current.
        set: {
          status: 'requested',
          contentHash,
          html: null,
          failedBlockIds: [],
          updatedAt: new Date(),
        },
      })
    if (enqueue) await enqueue(tx)
    return 'requested'
  })
}

/** Move a translation row to a new status (worker side). */
export async function setTranslationStatus(
  db: Db,
  articleId: number,
  targetLang: string,
  status: TranslationStatus,
  patch: Partial<
    Pick<ArticleTranslationRow, 'html' | 'failedBlockIds' | 'model' | 'contentHash'>
  > = {},
): Promise<void> {
  await db
    .insert(articleTranslations)
    .values({ articleId, targetLang, status, ...patch })
    .onConflictDoUpdate({
      target: [articleTranslations.articleId, articleTranslations.targetLang],
      set: { status, ...patch, updatedAt: new Date() },
    })
}

/** Store an eagerly translated title and excerpt without touching the body state. */
export async function setTranslatedTitle(
  db: Db,
  articleId: number,
  targetLang: string,
  fields: { title: string | null; excerpt: string | null; model: string },
): Promise<void> {
  await db
    .insert(articleTranslations)
    .values({ articleId, targetLang, status: 'pending', ...fields })
    .onConflictDoUpdate({
      target: [articleTranslations.articleId, articleTranslations.targetLang],
      set: { title: fields.title, excerpt: fields.excerpt, updatedAt: new Date() },
    })
}

export type Profile = typeof profiles.$inferSelect

export async function getProfile(db: Db, userId: string): Promise<Profile | null> {
  const [row] = await db.select().from(profiles).where(eq(profiles.id, userId))
  return row ?? null
}

export async function setReadingLang(db: Db, userId: string, readingLang: string): Promise<void> {
  await db.update(profiles).set({ readingLang }).where(eq(profiles.id, userId))
}

/** Today's LLM token usage caused by one member's requests, for their daily allowance. */
export async function tokensUsedTodayBy(db: Db, userId: string): Promise<number> {
  const [row] = await db.execute<{ total: number }>(
    sql`select coalesce(sum(input_tokens + output_tokens), 0)::int as total
        from llm_usage where user_id = ${userId} and created_at >= date_trunc('day', now())`,
  )
  return row?.total ?? 0
}

/** Today's LLM token usage, for the daily budget check. */
export async function tokensUsedToday(db: Db): Promise<number> {
  const [row] = await db.execute<{ total: number }>(
    sql`select coalesce(sum(input_tokens + output_tokens), 0)::int as total
        from llm_usage where created_at >= date_trunc('day', now())`,
  )
  return row?.total ?? 0
}

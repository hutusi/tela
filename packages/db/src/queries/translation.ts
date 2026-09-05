import type { TranslationStatus } from '@tela/shared'
import { and, eq, inArray, sql } from 'drizzle-orm'
import type { Db, DbExecutor, Tx } from '../client'
import { articleTranslations, profiles, translationRequests, translations } from '../schema'

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

export type RequestOutcome = 'requested' | 'in_progress' | 'ready' | 'budget_exhausted'

export type RequestReservation = {
  /** Member asking; reservations and recorded usage are metered against them. */
  requestedBy: string
  /** Source tokens this attempt is expected to send, capped at the per-article ceiling. */
  reserveTokens: number
  /** The member's allowance per UTC day. */
  allowanceTokens: number
}

/**
 * Source tokens reserved by a member's attempts still in flight, whenever they were made: a
 * backlog that outlives midnight must not let the member reserve a fresh allowance on top of it.
 */
export async function tokensReservedBy(db: DbExecutor, userId: string): Promise<number> {
  const [row] = await db.execute<{ total: number }>(
    sql`select coalesce(sum(r.reserved_tokens), 0)::int as total
        from translation_requests r
        join article_translations t on t.article_id = r.article_id and t.target_lang = r.target_lang
        where r.requested_by = ${userId} and t.status in ('requested', 'running')`,
  )
  return row?.total ?? 0
}

export type TranslationRequestRow = typeof translationRequests.$inferSelect

/** The reservation behind a body translation, if a member asked for it. */
export async function getTranslationRequest(
  db: DbExecutor,
  articleId: number,
  targetLang: string,
): Promise<TranslationRequestRow | null> {
  const [row] = await db
    .select()
    .from(translationRequests)
    .where(
      and(
        eq(translationRequests.articleId, articleId),
        eq(translationRequests.targetLang, targetLang),
      ),
    )
  return row ?? null
}

/**
 * Ask for a body translation. Returns 'ready' when a fresh translation exists,
 * 'in_progress' when one is already queued or running, and 'requested' when this call
 * created the request. A running attempt is never replaced, not even for changed content: its
 * worker is still spending against its reservation. The reader sees the stale row once it has
 * concluded and asks again; the scheduler gives up attempts that never conclude. Pass `enqueue` to insert the translate.body job inside the same
 * transaction: it runs after the status write and before commit, so a failure to enqueue
 * rolls the `requested` status back instead of stranding a row no worker will ever pick up.
 *
 * With a `reservation`, the request is refused as 'budget_exhausted' unless the member's
 * recorded usage today plus their attempts still in flight leave room for this estimate; the
 * estimate is then reserved on the row until the attempt concludes. Requests by one member are
 * serialised with an advisory lock, so a burst cannot all pass on the same headroom.
 *
 * Every request is a new attempt with its own id, handed to `enqueue` for the job payload.
 */
export async function requestBodyTranslation(
  db: Db,
  articleId: number,
  targetLang: string,
  contentHash: string | null,
  enqueue?: (tx: Tx, attempt: string) => Promise<void>,
  reservation?: RequestReservation,
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
    if (row?.status === 'running') return 'in_progress'
    if (reservation) {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${reservation.requestedBy}))`)
      const used = await tokensUsedTodayBy(tx, reservation.requestedBy)
      const reserved = await tokensReservedBy(tx, reservation.requestedBy)
      if (used + reserved + reservation.reserveTokens > reservation.allowanceTokens) {
        return 'budget_exhausted'
      }
    }
    const attempt = crypto.randomUUID()
    await tx
      .insert(articleTranslations)
      .values({ articleId, targetLang, contentHash, status: 'requested', attempt })
      .onConflictDoUpdate({
        target: [articleTranslations.articleId, articleTranslations.targetLang],
        // The old html belongs to the previous content version; it must not show as current.
        set: {
          status: 'requested',
          contentHash,
          html: null,
          failedBlockIds: [],
          attempt,
          updatedAt: new Date(),
        },
      })
    // The requester and the estimate live in a service-only table: article_translations is
    // readable through the Data API, and who asked for a translation is nobody's business.
    const requestedBy = reservation?.requestedBy ?? null
    const reservedTokens = reservation?.reserveTokens ?? 0
    await tx
      .insert(translationRequests)
      .values({ articleId, targetLang, requestedBy, reservedTokens })
      .onConflictDoUpdate({
        target: [translationRequests.articleId, translationRequests.targetLang],
        set: { requestedBy, reservedTokens, resends: 0, updatedAt: new Date() },
      })
    if (enqueue) await enqueue(tx, attempt)
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

/**
 * Move the row on behalf of one attempt. The write applies only while the row still carries
 * that attempt, compared on the row itself in the same statement, so a job that was superseded,
 * re-sent, or given up never overwrites the row it lost, and no interleaving with the scheduler
 * can let it. A refusal tells the worker to stop. A `running` write is also the heartbeat the
 * scheduler watches for. Returns whether the write applied.
 */
export async function transitionAttempt(
  db: Db,
  articleId: number,
  targetLang: string,
  attempt: string,
  status: TranslationStatus,
  patch: Partial<
    Pick<ArticleTranslationRow, 'html' | 'failedBlockIds' | 'model' | 'contentHash'>
  > = {},
): Promise<boolean> {
  const rows = await db
    .update(articleTranslations)
    .set({ status, ...patch, updatedAt: new Date() })
    .where(
      and(
        eq(articleTranslations.articleId, articleId),
        eq(articleTranslations.targetLang, targetLang),
        eq(articleTranslations.attempt, attempt),
      ),
    )
    .returning({ articleId: articleTranslations.articleId })
  return rows.length > 0
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
export async function tokensUsedTodayBy(db: DbExecutor, userId: string): Promise<number> {
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

export type StaleAttempt = {
  articleId: number
  targetLang: string
  requestedBy: string | null
  attempt: string
}
type RawStale = {
  article_id: string
  target_lang: string
  requested_by: string | null
  attempt: string
}
const fromRaw = (r: RawStale): StaleAttempt => ({
  articleId: Number(r.article_id),
  targetLang: r.target_lang,
  requestedBy: r.requested_by,
  attempt: r.attempt,
})

/** When the scheduler treats an attempt as lost, and when it stops trying. */
export type SweepPolicy = {
  /** A `requested` row this old lost its job (the handler flips a row to running at once). */
  requestedMinutes: number
  /** A `running` row without a heartbeat this long lost its worker. */
  runningMinutes: number
  /** Replacements a dead running attempt may get before the row is given up. */
  maxResends: number
  /** A `running` row without a heartbeat this long is given up regardless (a backstop). */
  abandonedMinutes: number
}

/**
 * The attempts whose jobs are presumed lost, with what a replacement job needs. A `running` row
 * without a heartbeat goes back to `requested` under a fresh attempt, in one statement on that
 * row, so a straggler still on the old attempt is refused at its next write; the resend is
 * counted on the request. From then on the row is a `requested` one and follows that rule: no
 * further rotation while the replacement waits in the queue. A `requested` row keeps its
 * attempt, since its job may only be waiting and the re-send is then dropped as a duplicate.
 */
export async function staleAttempts(
  db: Db,
  policy: Pick<SweepPolicy, 'requestedMinutes' | 'runningMinutes' | 'maxResends'>,
  limit = 200,
): Promise<StaleAttempt[]> {
  return db.transaction(async (tx) => {
    const replaced = await tx.execute<RawStale>(sql`
      with dead as (
        select t.article_id, t.target_lang, r.requested_by
          from article_translations t
          join translation_requests r
            on r.article_id = t.article_id and r.target_lang = t.target_lang
         where t.status = 'running'
           and t.updated_at < now() - make_interval(mins => ${policy.runningMinutes})
           and r.resends < ${policy.maxResends}
         order by t.updated_at asc
         limit ${limit})
      update article_translations t
         set attempt = gen_random_uuid(), status = 'requested', updated_at = now()
        from dead
       where t.article_id = dead.article_id and t.target_lang = dead.target_lang
       returning t.article_id, t.target_lang, dead.requested_by, t.attempt`)
    const rows = [...replaced]
    if (rows.length > 0) {
      await tx.execute(sql`
        update translation_requests r
           set resends = r.resends + 1, updated_at = now()
         where (r.article_id, r.target_lang) in (${sql.join(
           rows.map((d) => sql`(${d.article_id}::bigint, ${d.target_lang})`),
           sql`, `,
         )})`)
    }
    const waiting = await tx.execute<RawStale>(sql`
      select t.article_id, t.target_lang, r.requested_by, t.attempt
        from article_translations t
        join translation_requests r
          on r.article_id = t.article_id and r.target_lang = t.target_lang
       where t.status = 'requested'
         and t.updated_at < now() - make_interval(mins => ${policy.requestedMinutes})
       order by t.updated_at asc
       limit ${limit}`)
    return [...rows, ...waiting].map(fromRaw)
  })
}

/**
 * Give up on translations that will never conclude: a `running` row without a heartbeat whose
 * replacements are used up, one without a heartbeat for `abandonedMinutes` regardless, and rows
 * in flight with no request behind them (from before requests existed; nothing can run them).
 * They are failed with no html, which releases the reservation and lets the reader ask again,
 * and the attempt is retired in the same statement so a straggler cannot revive the row.
 * Returns how many were given up.
 */
export async function abandonStaleAttempts(
  db: DbExecutor,
  policy: Pick<SweepPolicy, 'runningMinutes' | 'maxResends' | 'abandonedMinutes'>,
): Promise<number> {
  const dead = await db.execute<{ article_id: string }>(sql`
    update article_translations t
       set status = 'failed', html = null, attempt = gen_random_uuid(), updated_at = now()
     where (t.status = 'running'
            and t.updated_at < now() - make_interval(mins => ${policy.runningMinutes})
            and exists (select 1 from translation_requests r
                         where r.article_id = t.article_id and r.target_lang = t.target_lang
                           and r.resends >= ${policy.maxResends}))
        or (t.status = 'running'
            and t.updated_at < now() - make_interval(mins => ${policy.abandonedMinutes}))
        or (t.status in ('requested', 'running')
            and not exists (select 1 from translation_requests r
                             where r.article_id = t.article_id and r.target_lang = t.target_lang))
     returning t.article_id`)
  return [...dead].length
}

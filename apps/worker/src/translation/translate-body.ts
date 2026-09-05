import { rehydrateBlocks, taggedTextsOf } from '@tela/content'
import { articleContents, articles, type Db, feeds, sites } from '@tela/db'
import {
  getArticleTranslation,
  getCachedTranslations,
  getTranslationRequest,
  setTranslationStatus,
  storeTranslations,
  tokensUsedToday,
  transitionAttempt,
} from '@tela/db/queries'
import { estimateTokens, type Translator, translateBlocks } from '@tela/llm'
import { NORM_VERSION } from '@tela/shared'
import { eq } from 'drizzle-orm'
import { recordUsage } from './usage'

export type TranslationDeps = {
  db: Db
  translator: Translator
  /** Daily token budget for background work; 0 = unlimited. */
  dailyBudgetTokens?: number
  /** Ceiling on source tokens per article body; blocks past it are left as source. */
  maxArticleTokens?: number
}

/** Thrown from the chunk callback when the attempt is no longer current: stop spending. */
class AttemptLostError extends Error {
  override name = 'AttemptLostError'
}

export type BodyOutcome = {
  status: 'done' | 'partial' | 'failed' | 'skipped'
  reason?: string
  translated: number
  cached: number
  failed: number
  /** Set when this job's attempt was superseded: the current attempt that still needs a job. */
  resend?: { attempt: string; requestedBy: string | null }
}

/**
 * Translate an article body into `targetLang`, block by block through the cache, and
 * materialize the rehydrated HTML on article_translations. Idempotent: a rerun only
 * translates blocks that are still missing from the cache.
 */
export async function translateArticleBody(
  deps: TranslationDeps,
  articleId: number,
  targetLang: string,
  options: { onDemand?: boolean; requestedBy?: string; attempt?: string; deadline?: number } = {},
): Promise<BodyOutcome> {
  const [row] = await deps.db
    .select({
      article: articles,
      contents: articleContents,
      feedTitle: feeds.title,
      siteTitle: sites.title,
      optOut: sites.translationOptOut,
    })
    .from(articles)
    .innerJoin(feeds, eq(feeds.id, articles.feedId))
    .innerJoin(sites, eq(sites.id, feeds.siteId))
    .leftJoin(articleContents, eq(articleContents.articleId, articles.id))
    .where(eq(articles.id, articleId))
  const none: BodyOutcome = { status: 'skipped', translated: 0, cached: 0, failed: 0 }
  // Every status write is made on behalf of this job's attempt and applies only while that
  // attempt is still the current request, so a job that was superseded, re-sent, or given up
  // cannot overwrite the row it lost. Without an attempt (one-off runs) writes are unconditional.
  const write = async (
    status: Parameters<typeof setTranslationStatus>[3],
    patch: Parameters<typeof setTranslationStatus>[4] = {},
  ): Promise<boolean> => {
    if (options.attempt) {
      return transitionAttempt(deps.db, articleId, targetLang, options.attempt, status, patch)
    }
    await setTranslationStatus(deps.db, articleId, targetLang, status, patch)
    return true
  }
  // A refused write: the attempt is no longer current. Name the one that is, so the handler
  // can make sure it has a job (the queue may have dropped it as a duplicate of this one).
  const superseded = async (): Promise<BodyOutcome> => {
    const current = await getArticleTranslation(deps.db, articleId, targetLang)
    const inFlight = current?.status === 'requested' || current?.status === 'running'
    if (!current || !inFlight) return { ...none, reason: 'superseded' }
    const request = await getTranslationRequest(deps.db, articleId, targetLang)
    return {
      ...none,
      reason: 'superseded',
      resend: { attempt: current.attempt, requestedBy: request?.requestedBy ?? null },
    }
  }
  if (!row) return { ...none, reason: 'article not found' }
  const { article, contents } = row
  if (!contents || !contents.html) {
    if (!(await write('failed', { html: null, contentHash: article.contentHash }))) {
      return superseded()
    }
    return { ...none, status: 'failed', reason: 'no content' }
  }
  if (article.sourceLang === targetLang) {
    if (!(await write('done', { html: null, contentHash: article.contentHash }))) {
      return superseded()
    }
    return { ...none, reason: 'same language' }
  }
  if (row.optOut) {
    if (!(await write('failed', { html: null, contentHash: article.contentHash }))) {
      return superseded()
    }
    return { ...none, status: 'failed', reason: 'site opted out of translation' }
  }
  if (!options.onDemand && deps.dailyBudgetTokens) {
    const used = await tokensUsedToday(deps.db)
    if (used >= deps.dailyBudgetTokens) return { ...none, reason: 'daily budget exhausted' }
  }
  // The attempt is bound to what was requested. If the body changed since (extraction, a
  // refresh), the reservation was made for other content: fail against the requested hash so
  // the reader sees a stale row and asks again with a fresh reservation. A reservation also
  // caps the attempt, so the member never pays for more than they reserved.
  const requested = await getArticleTranslation(deps.db, articleId, targetLang)
  const request = await getTranslationRequest(deps.db, articleId, targetLang)
  // A job carrying an older attempt was superseded by a newer request; the queue dedups by
  // article and language, so that request may have no job of its own. Step aside and let the
  // handler send one for the current attempt.
  if (options.attempt && requested && requested.attempt !== options.attempt) return superseded()
  const inFlight = requested?.status === 'requested' || requested?.status === 'running'
  if (inFlight && requested.contentHash !== article.contentHash) {
    if (!(await write('failed', { html: null, contentHash: requested.contentHash }))) {
      return superseded()
    }
    return { ...none, reason: 'content changed since the request' }
  }
  const maxArticleTokens = Math.min(
    deps.maxArticleTokens ?? Number.POSITIVE_INFINITY,
    request && request.reservedTokens > 0 ? request.reservedTokens : Number.POSITIVE_INFINITY,
  )

  if (!(await write('running', { contentHash: article.contentHash }))) return superseded()

  const tagged = taggedTextsOf(contents.html)
  const hashById = new Map(contents.blocks.map((b) => [b.id, b.hash]))
  const blocks = Object.entries(tagged)
    .filter(([id]) => hashById.has(id))
    .map(([id, text]) => ({ id, text, hash: hashById.get(id) as string }))

  const cached = await getCachedTranslations(
    deps.db,
    [...new Set(blocks.map((b) => b.hash))],
    targetLang,
    article.sourceLang,
  )
  // The ceiling is measured over the whole body, not over what is still missing, so a rerun
  // cannot translate "the next prefix" until the cap means nothing. Cached blocks past the
  // ceiling are free and are used; uncached ones stay as source.
  const translatedById = new Map<string, string>()
  const missing: Array<{ id: string; text: string }> = []
  const capped: Array<{ id: string; reason: string }> = []
  let budget = maxArticleTokens
  let cachedCount = 0
  for (const b of blocks) {
    budget -= estimateTokens(b.text)
    const hit = cached.get(b.hash)
    if (hit !== undefined) {
      translatedById.set(b.id, hit)
      cachedCount += 1
    } else if (budget < 0) capped.push({ id: b.id, reason: 'article too long' })
    else missing.push({ id: b.id, text: b.text })
  }

  let failed: Array<{ id: string; reason: string }> = capped
  if (missing.length > 0) {
    let outcome: Awaited<ReturnType<typeof translateBlocks>>
    try {
      outcome = await translateBlocks(deps.translator, {
        blocks: missing,
        sourceLang: article.sourceLang,
        targetLang,
        context: { title: article.title, siteTitle: row.siteTitle ?? row.feedTitle },
        ...(options.deadline !== undefined ? { deadline: options.deadline } : {}),
        // Persist every chunk as it lands: a retried or expired job resumes from the cache
        // instead of paying again, and today's usage reflects work in flight.
        onChunk: async ({ translated, usage }) => {
          // Duplicate blocks in one chunk share a hash; keep one entry per hash.
          const seen = new Set<string>()
          const entries = [...translated.entries()]
            .map(([id, text]) => ({
              sourceHash: hashById.get(id) as string,
              targetLang,
              taggedText: text,
              sourceLang: article.sourceLang,
              model: deps.translator.model,
              normVersion: NORM_VERSION,
              chars: text.length,
            }))
            .filter((e) => (seen.has(e.sourceHash) ? false : (seen.add(e.sourceHash), true)))
          await storeTranslations(deps.db, entries)
          await recordUsage(
            deps.db,
            'translate.body',
            articleId,
            targetLang,
            [usage],
            options.requestedBy ?? null,
          )
          // Heartbeat: the scheduler treats a running row without one as dead. A refused one
          // means the attempt was given up or replaced meanwhile: stop spending on it.
          if (!(await write('running'))) throw new AttemptLostError('attempt no longer current')
        },
      })
    } catch (err) {
      if (err instanceof AttemptLostError) return { ...none, reason: 'attempt lost' }
      await write('failed', {
        html: null,
        contentHash: article.contentHash,
      })
      throw err
    }
    if (outcome.stopped) {
      // Out of execution budget with chunks still to send: continue the same attempt in a fresh
      // job rather than overlap this one's retry once its lease expires. The heartbeat is recent
      // and the chunks stored so far are picked up from the cache.
      return {
        ...none,
        reason: 'continued',
        translated: outcome.translated.size,
        cached: cachedCount,
        ...(options.attempt
          ? { resend: { attempt: options.attempt, requestedBy: options.requestedBy ?? null } }
          : {}),
      }
    }
    failed = [...capped, ...outcome.failed]
    for (const [id, text] of outcome.translated) translatedById.set(id, text)
  }

  const html = rehydrateBlocks(contents.html, Object.fromEntries(translatedById))
  const status = failed.length === 0 ? 'done' : translatedById.size > 0 ? 'partial' : 'failed'
  const patch = {
    html: status === 'failed' ? null : html,
    failedBlockIds: failed.map((f) => f.id),
    model: deps.translator.model,
    contentHash: article.contentHash,
  }
  // Blocks translated by an attempt that was replaced meanwhile stay in the cache for the next
  // one; only the row must not be overwritten.
  if (!(await write(status, patch))) return superseded()
  return {
    status,
    translated: translatedById.size - cachedCount,
    cached: cachedCount,
    failed: failed.length,
  }
}

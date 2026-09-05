import { rehydrateBlocks, taggedTextsOf } from '@tela/content'
import { articleContents, articles, type Db, feeds, sites } from '@tela/db'
import {
  getCachedTranslations,
  setTranslationStatus,
  storeTranslations,
  tokensUsedToday,
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

export type BodyOutcome = {
  status: 'done' | 'partial' | 'failed' | 'skipped'
  reason?: string
  translated: number
  cached: number
  failed: number
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
  options: { onDemand?: boolean } = {},
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
  if (!row) return { ...none, reason: 'article not found' }
  const { article, contents } = row
  if (!contents || !contents.html) {
    await setTranslationStatus(deps.db, articleId, targetLang, 'failed', {
      contentHash: article.contentHash,
    })
    return { ...none, status: 'failed', reason: 'no content' }
  }
  if (article.sourceLang === targetLang) {
    await setTranslationStatus(deps.db, articleId, targetLang, 'done', {
      html: null,
      contentHash: article.contentHash,
    })
    return { ...none, reason: 'same language' }
  }
  if (row.optOut) {
    await setTranslationStatus(deps.db, articleId, targetLang, 'failed', {
      contentHash: article.contentHash,
    })
    return { ...none, status: 'failed', reason: 'site opted out of translation' }
  }
  if (!options.onDemand && deps.dailyBudgetTokens) {
    const used = await tokensUsedToday(deps.db)
    if (used >= deps.dailyBudgetTokens) return { ...none, reason: 'daily budget exhausted' }
  }

  await setTranslationStatus(deps.db, articleId, targetLang, 'running', {
    contentHash: article.contentHash,
  })

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
  let budget = deps.maxArticleTokens ?? Number.POSITIVE_INFINITY
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
          await recordUsage(deps.db, 'translate.body', articleId, targetLang, [usage])
        },
      })
    } catch (err) {
      await setTranslationStatus(deps.db, articleId, targetLang, 'failed', {
        contentHash: article.contentHash,
      })
      throw err
    }
    failed = [...capped, ...outcome.failed]
    for (const [id, text] of outcome.translated) translatedById.set(id, text)
  }

  const html = rehydrateBlocks(contents.html, Object.fromEntries(translatedById))
  const status = failed.length === 0 ? 'done' : translatedById.size > 0 ? 'partial' : 'failed'
  await setTranslationStatus(deps.db, articleId, targetLang, status, {
    html: status === 'failed' ? null : html,
    failedBlockIds: failed.map((f) => f.id),
    model: deps.translator.model,
    contentHash: article.contentHash,
  })
  return {
    status,
    translated: translatedById.size - cachedCount,
    cached: cachedCount,
    failed: failed.length,
  }
}

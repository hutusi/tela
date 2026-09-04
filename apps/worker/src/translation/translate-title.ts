import { blockHash } from '@tela/content'
import { plainText } from '@tela/content/tagged'
import { articles, feeds, sites } from '@tela/db'
import {
  getCachedTranslations,
  setTranslatedTitle,
  storeTranslations,
  tokensUsedToday,
} from '@tela/db/queries'
import { translateBlocks } from '@tela/llm'
import { NORM_VERSION } from '@tela/shared'
import { eq } from 'drizzle-orm'
import { escapeUTF8 } from 'entities'
import type { TranslationDeps } from './translate-body'
import { recordUsage } from './usage'

export type TitleOutcome = {
  status: 'done' | 'skipped' | 'failed' | 'deferred'
  reason?: string
}

/**
 * Eagerly translate an article's title and excerpt (cheap, and what the list shows). Uses
 * the same content-addressed cache as bodies, keyed by the escaped plain text. Title work is
 * background work, so once the daily budget is spent a cache miss is `deferred` (the handler
 * re-queues it for the next day); cache hits still complete.
 */
export async function translateArticleTitle(
  deps: TranslationDeps,
  articleId: number,
  targetLang: string,
): Promise<TitleOutcome> {
  const [row] = await deps.db
    .select({
      article: articles,
      siteTitle: sites.title,
      feedTitle: feeds.title,
      optOut: sites.translationOptOut,
    })
    .from(articles)
    .innerJoin(feeds, eq(feeds.id, articles.feedId))
    .innerJoin(sites, eq(sites.id, feeds.siteId))
    .where(eq(articles.id, articleId))
  if (!row) return { status: 'skipped', reason: 'article not found' }
  const { article } = row
  if (!article.title.trim()) return { status: 'skipped', reason: 'no title' }
  if (article.sourceLang === targetLang || row.optOut)
    return { status: 'skipped', reason: 'not needed' }

  const blocks = [{ id: 'title', text: escapeUTF8(article.title) }]
  if (article.excerpt) blocks.push({ id: 'excerpt', text: escapeUTF8(article.excerpt) })
  const hashes = new Map<string, string>()
  for (const b of blocks) hashes.set(b.id, await blockHash(b.text))

  const cached = await getCachedTranslations(
    deps.db,
    [...hashes.values()],
    targetLang,
    article.sourceLang,
  )
  const result = new Map<string, string>()
  const missing: typeof blocks = []
  for (const b of blocks) {
    const hit = cached.get(hashes.get(b.id) as string)
    if (hit !== undefined) result.set(b.id, hit)
    else missing.push(b)
  }
  if (missing.length > 0) {
    if (deps.dailyBudgetTokens) {
      const used = await tokensUsedToday(deps.db)
      if (used >= deps.dailyBudgetTokens)
        return { status: 'deferred', reason: 'daily budget exhausted' }
    }
    const outcome = await translateBlocks(deps.translator, {
      blocks: missing,
      sourceLang: article.sourceLang,
      targetLang,
      context: { siteTitle: row.siteTitle ?? row.feedTitle },
    })
    await storeTranslations(
      deps.db,
      [...outcome.translated.entries()].map(([id, text]) => ({
        sourceHash: hashes.get(id) as string,
        targetLang,
        taggedText: text,
        sourceLang: article.sourceLang,
        model: deps.translator.model,
        normVersion: NORM_VERSION,
        chars: text.length,
      })),
    )
    for (const [id, text] of outcome.translated) result.set(id, text)
    await recordUsage(deps.db, 'translate.title', articleId, targetLang, outcome.usage)
    if (!result.has('title'))
      return { status: 'failed', reason: outcome.failed[0]?.reason ?? 'title failed' }
  }

  await setTranslatedTitle(deps.db, articleId, targetLang, {
    title: plainText(result.get('title') as string),
    excerpt: result.has('excerpt') ? plainText(result.get('excerpt') as string) : null,
    model: deps.translator.model,
  })
  return { status: 'done' }
}

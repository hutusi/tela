/**
 * Eager title translations (ADR 0006): what lists show, for a few hundred tokens an article. The
 * sweep finds articles whose current title hash has no translation into some launch language, so
 * an article whose title or excerpt changes is translated again without anything being queued.
 */
import { blockHash } from '@tela/content'
import { plainText } from '@tela/content/tagged'
import {
  BACKGROUND,
  cachedTranslations,
  chargeUsage,
  first,
  type Lease,
  recordLlmCall,
  storeBlockTranslations,
  upsertArticleTitle,
  utcDay,
} from '@tela/data'
import { commit, type IngestContext, type Statement } from '@tela/ingest/pipeline'
import { type Translator, translateBlocks } from '@tela/llm'
import { NORM_VERSION, READING_LANGUAGES } from '@tela/shared'
import { sql } from 'drizzle-orm'
import { escapeUTF8 } from 'entities'

export type TranslationContext = IngestContext & {
  /** Absent when no provider is configured; the translation kinds are disabled then. */
  translator?: Translator
  /** Daily token budget for background work (titles); 0 = unlimited. */
  backgroundBudget?: number
  /** Ceiling on source tokens translated per article body. */
  maxArticleTokens?: number
}

export type TitleResult =
  | { status: 'done'; languages: string[] }
  | { status: 'skipped'; reason: string }
  | { status: 'retry'; error: string }
  | { status: 'lost' }

/** Translate an article's title and excerpt into every launch language it is not written in. */
export async function translateTitlesJob(
  ctx: TranslationContext,
  lease: Lease,
): Promise<TitleResult> {
  const { db } = ctx
  const articleId = Number(lease.key)
  const skip = async (reason: string): Promise<TitleResult> => {
    const committed = await commit(ctx, lease, [])
    return committed.ok ? { status: 'skipped', reason } : { status: 'lost' }
  }
  const translator = ctx.translator
  if (!translator) return skip('no translator configured')
  const article = await first<{
    feed_id: number
    title: string
    excerpt: string | null
    source_lang: string | null
    title_hash: string | null
    site_title: string | null
    opt_out: number
  }>(
    db,
    sql`
      select a.feed_id, a.title, a.excerpt, a.source_lang, a.title_hash,
        coalesce(s.title, f.title) as site_title, s.translation_opt_out as opt_out
      from articles a join feeds f on f.id = a.feed_id join sites s on s.id = f.site_id
      where a.id = ${articleId}
    `,
  )
  if (!article?.title_hash || !article.title.trim()) return skip('no title')
  if (article.opt_out) return skip('the site opted out of translation')
  const done = new Map(
    (
      await db.all<{ lang: string; source_hash: string }>(
        sql`select lang, source_hash from article_titles where article_id = ${articleId}`,
      )
    ).map((r) => [r.lang, r.source_hash]),
  )
  const targets = READING_LANGUAGES.filter(
    (lang) => lang !== article.source_lang && done.get(lang) !== article.title_hash,
  )
  if (targets.length === 0) return skip('up to date')

  const blocks = [{ id: 'title', text: escapeUTF8(article.title) }]
  if (article.excerpt) blocks.push({ id: 'excerpt', text: escapeUTF8(article.excerpt) })
  const hashes = new Map<string, string>()
  for (const b of blocks) hashes.set(b.id, await blockHash(b.text))

  const now = ctx.clock.now()
  const statements: Statement[] = []
  let spent = 0
  for (const lang of targets) {
    const cached = await cachedTranslations(db, [...hashes.values()], lang, article.source_lang)
    const result = new Map<string, string>()
    const missing: typeof blocks = []
    for (const b of blocks) {
      const hit = cached.get(hashes.get(b.id) as string)
      if (hit !== undefined) result.set(b.id, hit)
      else missing.push(b)
    }
    let echoedTitle = false
    if (missing.length > 0) {
      let outcome: Awaited<ReturnType<typeof translateBlocks>>
      try {
        outcome = await translateBlocks(translator, {
          blocks: missing,
          sourceLang: article.source_lang,
          targetLang: lang,
          context: { siteTitle: article.site_title },
          // A title may be a name that reads the same in every language; the excerpt keeps the
          // echo guard.
          allowIdenticalBlockIds: ['title'],
        })
      } catch (err) {
        // The provider is down or refusing: back the lease off rather than record a failure.
        return { status: 'retry', error: err instanceof Error ? err.message : String(err) }
      }
      for (const usage of outcome.usage) {
        spent += usage.inputTokens + usage.outputTokens
        statements.push(
          recordLlmCall(
            db,
            {
              job: 'translate.title',
              contentKey: null,
              articleId,
              targetLang: lang,
              userId: null,
              model: usage.model,
              inputTokens: usage.inputTokens,
              outputTokens: usage.outputTokens,
              latencyMs: usage.latencyMs,
            },
            now,
          ),
        )
      }
      // An echo accepted only by the title exemption stays out of the shared cache: it is
      // content-addressed and first-write-wins, so a body <h1> repeating the headline would
      // inherit "this is its own translation" for ever (AGENTS.md).
      const cacheable = [...outcome.translated.entries()].filter(([id]) => !outcome.echoed.has(id))
      if (cacheable.length > 0) {
        statements.push(
          storeBlockTranslations(
            db,
            cacheable.map(([id, text]) => ({
              sourceHash: hashes.get(id) as string,
              taggedText: text,
            })),
            {
              targetLang: lang,
              sourceLang: article.source_lang,
              model: translator.model,
              normVersion: NORM_VERSION,
            },
            now,
          ),
        )
      }
      for (const [id, text] of outcome.translated) result.set(id, text)
      echoedTitle = outcome.echoed.has('title')
    }
    const title = result.get('title')
    const excerpt = result.get('excerpt')
    statements.push(
      upsertArticleTitle(
        db,
        {
          articleId,
          lang,
          feedId: article.feed_id,
          title: title === undefined ? null : plainText(title),
          excerpt: excerpt === undefined ? null : plainText(excerpt),
          // Failed and echoed titles are recorded too, so the sweep stops asking until the
          // title itself changes.
          status: title === undefined ? 'failed' : echoedTitle ? 'echo' : 'done',
          sourceHash: article.title_hash,
          model: translator.model,
        },
        now,
      ),
    )
  }
  if (spent > 0) statements.push(chargeUsage(db, BACKGROUND, utcDay(now), spent))
  const committed = await commit(ctx, lease, statements)
  return committed.ok ? { status: 'done', languages: targets } : { status: 'lost' }
}

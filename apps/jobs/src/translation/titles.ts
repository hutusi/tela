/**
 * Eager title translations (ADR 0006): what lists show, for a few hundred tokens an article. The
 * sweep finds feeds with articles whose current title hash has no translation into some launch
 * language, so an article whose title or excerpt changes is translated again without anything
 * being queued. A job takes one feed's due titles together: one call per language carries up to
 * `TITLES_PER_JOB` of them, so the prompt is paid once, not once an article.
 */
import { blockHash } from '@tela/content'
import { plainText } from '@tela/content/tagged'
import {
  BACKGROUND,
  cachedTranslations,
  chargeUsage,
  type DueTitle,
  dueTitlesOfFeed,
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
  | { status: 'done'; articles: number; languages: Record<string, number> }
  | { status: 'skipped'; reason: string }
  | { status: 'retry'; error: string }
  | { status: 'lost' }

/** How long a title job holds its lease: a call per language for up to 20 titles, and retries. */
export const TITLE_TTL_MS = 5 * 60_000

type Block = { id: string; text: string; hash: string }

/** An article's title and excerpt as blocks, ids unique across the batch. */
async function blocksOf(article: DueTitle): Promise<Block[]> {
  const blocks = [{ id: `t${article.id}`, text: escapeUTF8(article.title) }]
  if (article.excerpt) blocks.push({ id: `e${article.id}`, text: escapeUTF8(article.excerpt) })
  return Promise.all(blocks.map(async (b) => ({ ...b, hash: await blockHash(b.text) })))
}

/**
 * Translate a feed's due titles and excerpts into every launch language each is not written in.
 * The key is the feed id. Work is grouped by (target language, source language), one
 * `translateBlocks` call a group. A group the provider refuses leaves the rest standing: what
 * succeeded is committed and the lease backs off, so paid work is never thrown away.
 */
export async function translateTitlesJob(
  ctx: TranslationContext,
  lease: Lease,
): Promise<TitleResult> {
  const { db } = ctx
  const feedId = Number(lease.key)
  const skip = async (reason: string): Promise<TitleResult> => {
    const committed = await commit(ctx, lease, [])
    return committed.ok ? { status: 'skipped', reason } : { status: 'lost' }
  }
  const translator = ctx.translator
  if (!translator) return skip('no translator configured')
  const site = await first<{ site_title: string | null }>(
    db,
    sql`
      select coalesce(s.title, f.title) as site_title
      from feeds f join sites s on s.id = f.site_id where f.id = ${feedId}
    `,
  )
  // The due query already leaves out opted-out sites and blank titles.
  const articles = site ? await dueTitlesOfFeed(db, feedId) : []
  if (articles.length === 0) return skip('up to date')

  const done = new Map(
    (
      await db.all<{ article_id: number; lang: string; source_hash: string }>(sql`
        select article_id, lang, source_hash from article_titles
        where article_id in (select value from json_each(${JSON.stringify(articles.map((a) => a.id))}))
      `)
    ).map((r) => [`${r.article_id}:${r.lang}`, r.source_hash]),
  )
  const blocks = new Map<number, Block[]>()
  for (const article of articles) blocks.set(article.id, await blocksOf(article))

  // (target, source) → the articles that need it.
  const groups = new Map<
    string,
    { lang: string; sourceLang: string | null; articles: DueTitle[] }
  >()
  for (const article of articles) {
    for (const lang of READING_LANGUAGES) {
      if (lang === article.source_lang) continue
      if (done.get(`${article.id}:${lang}`) === article.title_hash) continue
      const key = `${lang}\u0000${article.source_lang ?? ''}`
      const group = groups.get(key) ?? { lang, sourceLang: article.source_lang, articles: [] }
      group.articles.push(article)
      groups.set(key, group)
    }
  }

  const now = ctx.clock.now()
  const statements: Statement[] = []
  const translatedCount = new Map<string, number>()
  let spent = 0
  let providerError: string | null = null
  for (const { lang, sourceLang, articles: members } of groups.values()) {
    const all = members.flatMap((a) => blocks.get(a.id) as Block[])
    const cached = await cachedTranslations(
      db,
      all.map((b) => b.hash),
      lang,
      sourceLang,
    )
    const result = new Map<string, string>()
    const missing: Block[] = []
    for (const b of all) {
      const hit = cached.get(b.hash)
      if (hit !== undefined) result.set(b.id, hit)
      else missing.push(b)
    }
    const echoed = new Set<string>()
    if (missing.length > 0) {
      let outcome: Awaited<ReturnType<typeof translateBlocks>>
      try {
        outcome = await translateBlocks(translator, {
          blocks: missing.map(({ id, text }) => ({ id, text })),
          sourceLang,
          targetLang: lang,
          context: { siteTitle: site?.site_title ?? null },
          // A title may be a name that reads the same in every language; excerpts keep the
          // echo guard.
          allowIdenticalBlockIds: missing.filter((b) => b.id.startsWith('t')).map((b) => b.id),
        })
      } catch (err) {
        // The provider is down or refusing: keep what other groups made, back off for the rest.
        providerError = err instanceof Error ? err.message : String(err)
        continue
      }
      for (const usage of outcome.usage) {
        spent += usage.inputTokens + usage.outputTokens
        statements.push(
          recordLlmCall(
            db,
            {
              job: 'translate.title',
              contentKey: null,
              articleId: members.length === 1 ? (members[0] as DueTitle).id : null,
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
      const hashOf = new Map(missing.map((b) => [b.id, b.hash]))
      const cacheable = [...outcome.translated.entries()].filter(([id]) => !outcome.echoed.has(id))
      if (cacheable.length > 0) {
        statements.push(
          storeBlockTranslations(
            db,
            cacheable.map(([id, text]) => ({
              sourceHash: hashOf.get(id) as string,
              taggedText: text,
            })),
            { targetLang: lang, sourceLang, model: translator.model, normVersion: NORM_VERSION },
            now,
          ),
        )
      }
      for (const [id, text] of outcome.translated) result.set(id, text)
      for (const id of outcome.echoed) echoed.add(id)
    }
    for (const article of members) {
      const title = result.get(`t${article.id}`)
      const excerpt = result.get(`e${article.id}`)
      statements.push(
        upsertArticleTitle(
          db,
          {
            articleId: article.id,
            lang,
            feedId,
            title: title === undefined ? null : plainText(title),
            excerpt: excerpt === undefined ? null : plainText(excerpt),
            // Failed and echoed titles are recorded too, so the sweep stops asking until the
            // title itself changes.
            status: title === undefined ? 'failed' : echoed.has(`t${article.id}`) ? 'echo' : 'done',
            sourceHash: article.title_hash,
            model: translator.model,
          },
          now,
        ),
      )
    }
    translatedCount.set(lang, (translatedCount.get(lang) ?? 0) + members.length)
  }
  if (spent > 0) statements.push(chargeUsage(db, BACKGROUND, utcDay(now), spent))
  if (providerError !== null) {
    // Keep the lease so runJob can back it off; what succeeded is written now.
    if (statements.length > 0) {
      const kept = await commit(ctx, lease, statements, { hold: { ttlMs: TITLE_TTL_MS } })
      if (!kept.ok) return { status: 'lost' }
    }
    return { status: 'retry', error: providerError }
  }
  const committed = await commit(ctx, lease, statements)
  return committed.ok
    ? { status: 'done', articles: articles.length, languages: Object.fromEntries(translatedCount) }
    : { status: 'lost' }
}

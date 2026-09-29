/**
 * Eager full-text extraction (ADR 0022): fetch an article's page under a per-host lease, run
 * Readability, and add a `readability` version when it is clearly longer than the feed's.
 * Versions are never overwritten, so the feed's own version stays for the day the summary
 * changes and extraction runs again.
 */
import { buildContentObject, objectKeys, processArticleHtml, sha256Hex } from '@tela/content'
import { extractArticle } from '@tela/content/extract'
import {
  adoptExtractedVersion,
  chooseCurrent,
  EXTRACTION_MUST_BE_LONGER_BY,
  type Lease,
  loadArticleForExtraction,
  type StoredVersion,
  settleExtraction,
} from '@tela/data'
import { HttpError } from '../http'
import { commit, type IngestContext } from './context'

/** Readability parses the whole page in memory; pages past this are skipped as too large. */
export const EXTRACTION_MAX_BYTES = 2 * 1024 * 1024

export type ExtractResult =
  | { status: 'extracted'; version: number; chars: number }
  | { status: 'settled'; state: 'done' | 'failed'; reason: string }
  /** Worth another try later (timeout, network, 5xx): the caller backs the lease off. */
  | { status: 'retry'; error: string }
  | { status: 'skipped'; reason: string }
  | { status: 'lost' }

const IMMUTABLE = 'public, max-age=31536000, immutable'

async function settle(
  ctx: IngestContext,
  lease: Lease,
  articleId: number,
  state: 'done' | 'failed',
  reason: string,
): Promise<ExtractResult> {
  const committed = await commit(ctx, lease, [settleExtraction(ctx.db, articleId, state)])
  return committed.ok ? { status: 'settled', state, reason } : { status: 'lost' }
}

/** Extract one article's page. `lease.key` is the article id. */
export async function extractArticleJob(ctx: IngestContext, lease: Lease): Promise<ExtractResult> {
  const article = await loadArticleForExtraction(ctx.db, Number(lease.key))
  if (article?.extractState !== 'due') {
    const committed = await commit(ctx, lease, [])
    return committed.ok ? { status: 'skipped', reason: 'not due' } : { status: 'lost' }
  }
  if (!article.url) return settle(ctx, lease, article.id, 'failed', 'article has no url')

  let page: Awaited<ReturnType<IngestContext['http']['get']>>
  try {
    page = await ctx.http.get(article.url, {
      region: article.fetchRegion,
      accept: 'text/html, application/xhtml+xml, */*;q=0.5',
      maxBytes: EXTRACTION_MAX_BYTES,
    })
  } catch (err) {
    if (!(err instanceof HttpError)) throw err
    if (err.kind === 'timeout' || err.kind === 'network') {
      return { status: 'retry', error: `${err.kind}: ${err.message}` }
    }
    return settle(ctx, lease, article.id, 'failed', `${err.kind}: ${err.message}`)
  }
  if (page.status >= 500 || page.status === 429 || page.status === 408) {
    return { status: 'retry', error: `http ${page.status}` }
  }
  if (page.status !== 200 || !page.body) {
    return settle(ctx, lease, article.id, 'failed', `http ${page.status}`)
  }

  const extracted = extractArticle(page.body, page.finalUrl)
  if (!extracted) return settle(ctx, lease, article.id, 'failed', 'no article content found')

  const processed = await processArticleHtml({
    html: extracted.contentHtml,
    baseUrl: page.finalUrl,
    langHint: article.sourceLang ?? extracted.lang,
    title: article.title,
  })
  const feedChars = Math.max(
    0,
    ...article.versions.filter((v) => v.provenance === 'feed').map((v) => v.bodyChars),
  )
  if (processed.text.length < feedChars * EXTRACTION_MUST_BE_LONGER_BY) {
    return settle(ctx, lease, article.id, 'done', 'extraction is not longer than the feed content')
  }

  const object = buildContentObject(processed)
  // A page unchanged since its last extraction is not a new version (invariant 6): re-running
  // extraction over a blog's posts once added a duplicate to 92 of 118 of them.
  const lastExtracted = article.versions
    .filter((v) => v.provenance === 'readability')
    .sort((a, b) => b.version - a.version)[0]
  if (lastExtracted?.contentKey === object.key) {
    return settle(ctx, lease, article.id, 'done', 'the page is unchanged since its last extraction')
  }
  const rawSha = await sha256Hex(extracted.contentHtml)
  await Promise.all([
    ctx.blobs.put(objectKeys.content(object.key), JSON.stringify(object), {
      contentType: 'application/json',
      cacheControl: IMMUTABLE,
    }),
    ctx.blobs.put(objectKeys.raw(rawSha), extracted.contentHtml, {
      contentType: 'text/html; charset=utf-8',
    }),
  ])
  const next = Math.max(0, ...article.versions.map((v) => v.version)) + 1
  const extractedVersion: StoredVersion = {
    version: next,
    provenance: 'readability',
    contentKey: object.key,
    bodyChars: processed.text.length,
    excerpt: processed.excerpt || null,
    wordCount: processed.wordCount,
    readingMinutes: processed.readingMinutes,
    lang: processed.lang === 'und' ? null : processed.lang,
  }
  const current = (chooseCurrent([...article.versions, extractedVersion], article.contentMode) ??
    extractedVersion) as StoredVersion
  const titleHash = (await sha256Hex(`${article.title}\n${current.excerpt ?? ''}`)).slice(0, 16)
  const committed = await commit(ctx, lease, [
    ...adoptExtractedVersion(
      ctx.db,
      article,
      { ...extractedVersion, rawKey: objectKeys.raw(rawSha), sourceUrl: page.finalUrl },
      current,
      titleHash,
      ctx.clock.now(),
    ),
  ])
  if (!committed.ok) return { status: 'lost' }
  return { status: 'extracted', version: next, chars: processed.text.length }
}

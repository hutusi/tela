/**
 * Full-text extraction for feeds that only ship summaries. Lives behind the
 * `@tela/content/extract` subpath because linkedom is heavy and only the worker needs it.
 */
import { Readability } from '@mozilla/readability'
import { parseHTML } from 'linkedom'

/** Extractions with less text than this are treated as failures. */
export const MIN_ARTICLE_CHARS = 100

export type ExtractedArticle = {
  title: string | null
  contentHtml: string
  byline: string | null
  excerpt: string | null
  lang: string | null
}

/** Run Readability over a fetched page. Output still needs sanitizeArticleHtml. */
export function extractArticle(html: string, url: string): ExtractedArticle | null {
  const { document } = parseHTML(html)
  // Give relative links a base so Readability can absolutize them.
  if (!document.querySelector('base[href]')) {
    const base = document.createElement('base')
    base.setAttribute('href', url)
    document.head?.appendChild(base)
  }
  type ReadabilityDocument = ConstructorParameters<typeof Readability>[0]
  const reader = new Readability(document as unknown as ReadabilityDocument, { charThreshold: 100 })
  const result = reader.parse()
  if (!result?.content) return null
  // Readability falls back to the whole body on thin pages; that is never an article.
  if ((result.textContent ?? '').trim().length < MIN_ARTICLE_CHARS) return null
  return {
    title: result.title || null,
    contentHtml: result.content,
    byline: result.byline || null,
    excerpt: result.excerpt || null,
    lang: result.lang || null,
  }
}

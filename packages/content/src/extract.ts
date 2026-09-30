/**
 * Full-text extraction for feeds that only ship summaries. Lives behind the
 * `@tela/content/extract` subpath because linkedom is heavy and only the worker needs it.
 */
import { Readability } from '@mozilla/readability'
import { parseHTML } from 'linkedom'

/** Extractions with less text than this are treated as failures. */
export const MIN_ARTICLE_CHARS = 100

/**
 * An extraction with this share of its text inside links is a menu or a list of cards, not a
 * post. Measured across ten blogs: the most link-heavy real post was 43%; a site menu readability
 * fell back to on a post of illustrations was 100%.
 */
export const MAX_LINK_DENSITY = 0.7

export type ExtractedArticle = {
  title: string | null
  contentHtml: string
  byline: string | null
  excerpt: string | null
  lang: string | null
}

/**
 * Classes and ids of what an indie blog puts beside a post and never in it: webmentions and
 * backlinks. Readability spares them whenever an ancestor's class says `content`, and on a post
 * that is mostly illustrations they are the largest text on the page. `mention` alone is not
 * here: it marks an @name inside a post.
 */
const BESIDE_THE_POST = /^(?:webmentions?|mentions|backlinks?)(?:[-_]|$)/i

/** Remove what a browser never shows as the post, before Readability scores the page. */
function dropNonContent(document: ReturnType<typeof parseHTML>['document']): void {
  // A <template> is inert in a browser; linkedom parses it as ordinary text (link previews).
  for (const el of [...document.querySelectorAll('template')]) el.remove()
  for (const el of [...document.querySelectorAll('[class], [id]')]) {
    const tokens = [...(el.getAttribute('class')?.split(/\s+/) ?? []), el.getAttribute('id') ?? '']
    if (tokens.some((t) => BESIDE_THE_POST.test(t))) el.remove()
  }
}

/** The share of an extraction's text, whitespace aside, that sits inside links. */
function linkDensity(document: ReturnType<typeof parseHTML>['document'], html: string): number {
  const probe = document.createElement('div')
  probe.innerHTML = html
  const chars = (text: string | null) => (text ?? '').replace(/\s+/g, '').length
  const total = chars(probe.textContent)
  if (total === 0) return 0
  let linked = 0
  for (const a of [...probe.querySelectorAll('a')]) linked += chars(a.textContent)
  return linked / total
}

/** Run Readability over a fetched page. Output still needs sanitizeArticleHtml. */
export function extractArticle(html: string, url: string): ExtractedArticle | null {
  const { document } = parseHTML(html)
  dropNonContent(document)
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
  if (linkDensity(document, result.content) >= MAX_LINK_DENSITY) return null
  return {
    title: result.title || null,
    contentHtml: result.content,
    byline: result.byline || null,
    excerpt: result.excerpt || null,
    lang: result.lang || null,
  }
}

/**
 * The front page's edition (ADR 0035): which post leads it, and how each post's titles show in
 * the mode the visitor chose. Titles open as written; `?titles=translated` puts the reader's
 * language first. A link, not a switch, so it works before any script runs and the edge caches
 * each mode apart.
 */
import type { FrontPost } from '../views/types'
import { nameIn, nativeName } from './language-name'

export const FRONT_PATH = '/api/v1/public/front'

export type TitlesMode = 'original' | 'translated'

export function titlesMode(params: URLSearchParams): TitlesMode {
  return params.get('titles') === 'translated' ? 'translated' : 'original'
}

/** The front page's own address in a mode: the default is the bare `/`. */
export function frontHref(mode: TitlesMode): string {
  return mode === 'translated' ? '/?titles=translated' : '/'
}

/** A post that rewards a lead: three minutes or more, with an excerpt to show. Else the newest. */
export function pickLead(posts: readonly FrontPost[]): FrontPost | null {
  return (
    posts.find((p) => p.article.readingMinutes >= 3 && Boolean(p.article.excerpt)) ??
    posts[0] ??
    null
  )
}

/**
 * The name a feed gives its post's author, as the lead's byline shows it beside the blog: RSS
 * writes `hello@site.com (Name)` and some feeds `Name <hello@site.com>`, which come down to the
 * name, and an address alone is no name. None when the blog's own name already says it ("Austin
 * Kleon", "Manuel Moreale — Everything Feed"), since the byline would only repeat it.
 */
export function bylineName(author: string | null, blog: string): string | null {
  const raw = author?.trim()
  if (!raw) return null
  const name = (
    /^\S+@\S+\s*\((.+)\)$/.exec(raw)?.[1] ??
    /^(.+?)\s*<\S+@\S+>$/.exec(raw)?.[1] ??
    raw
  ).trim()
  if (!name || /^\S+@\S+$/.test(name)) return null
  return blog.toLocaleLowerCase().includes(name.toLocaleLowerCase()) ? null : name
}

/** A text and the language it is in, for the element's `lang`. */
export type Shown = { text: string; lang: string | undefined }

export type EditionTitles = {
  /** The title set large: as written, or translated in that mode when there is a translation. */
  big: Shown
  /** The other one, small beneath it; null when the post is in the reader's language. */
  small: Shown | null
  /** The excerpt in the big title's language when it has one, else as written. */
  excerpt: Shown | null
  /** The post's language: its own name while titles are as written, the reader's name for it otherwise. */
  label: string | null
}

export function editionTitles(
  article: FrontPost['article'],
  mode: TitlesMode,
  reading: string,
  locale: string,
): EditionTitles {
  const source = article.sourceLang
  const original: Shown = { text: article.title, lang: source ?? undefined }
  const foreign = source !== null && source !== reading
  const title = foreign ? article.titles?.[reading] : undefined
  const translated: Shown | null = title ? { text: title, lang: reading } : null
  const excerptIn = foreign && mode === 'translated' ? article.excerpts?.[reading] : undefined
  const excerpt: Shown | null = excerptIn
    ? { text: excerptIn, lang: reading }
    : article.excerpt
      ? { text: article.excerpt, lang: source ?? undefined }
      : null
  const label = source ? (mode === 'original' ? nativeName(source) : nameIn(source, locale)) : null
  if (!translated) return { big: original, small: null, excerpt, label }
  return mode === 'translated'
    ? { big: translated, small: original, excerpt, label }
    : { big: original, small: translated, excerpt, label }
}

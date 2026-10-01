/**
 * Search on the device first: every post in the horizon and every blog the member follows is
 * already here, so the first results need no request. The server adds what is not: older posts
 * and blogs the member does not follow.
 */
import type { ArticleRow, Tables } from '@tela/sync'
import { titleKey } from '@tela/sync'

export type ArticleHit = { article: ArticleRow; translatedTitle: string | null }

const fold = (s: string) => s.toLocaleLowerCase().replace(/\s+/g, ' ')

/**
 * Newest first, as the lists are: by when it was published, not by id. A feed's first fetch
 * stores its posts newest first, so there the newest post has the lowest id.
 */
const newestFirst = (x: ArticleHit, y: ArticleHit) =>
  y.article.sortAt - x.article.sortAt || y.article.id - x.article.id

/** The query as it is matched: trimmed, whitespace collapsed, capped like the server's. */
export function normalizeQuery(raw: string | null): string {
  return (raw ?? '').trim().replace(/\s+/g, ' ').slice(0, 100)
}

export function searchLocal(
  t: Tables,
  query: string,
  readingLang: string,
  limit = 30,
): ArticleHit[] {
  const q = fold(normalizeQuery(query))
  if (!q) return []
  const hits: ArticleHit[] = []
  for (const a of t.articles.values()) {
    if (t.subscriptions.get(a.feedId)?.deletedAt !== null) continue
    const translated = t.titles.get(titleKey(a.id, readingLang))?.title ?? null
    if (fold(a.title).includes(q) || (translated !== null && fold(translated).includes(q))) {
      hits.push({ article: a, translatedTitle: translated })
    }
  }
  return hits.sort(newestFirst).slice(0, limit)
}

/** The device's hits, then the server's that it did not have, newest first. */
export function mergeHits(local: ArticleHit[], remote: ArticleHit[], limit = 30): ArticleHit[] {
  const seen = new Set(local.map((h) => h.article.id))
  return [...local, ...remote.filter((h) => !seen.has(h.article.id))]
    .sort(newestFirst)
    .slice(0, limit)
}

/**
 * How a hit reads. Its translation whenever it has one, since the query may have matched only
 * that and a hit must show the words typed (AGENTS.md), badged when the languages differ, with the
 * original beneath. A post in a language the member never translates reads as written and
 * unbadged, as it does everywhere else, with the translation beneath only when that is all the
 * query matched.
 */
export function hitTitles(
  hit: ArticleHit,
  query: string,
  readingLang: string,
  never: readonly string[],
): { main: string; secondary: string | null; badge: boolean } {
  const { article: a, translatedTitle } = hit
  if (a.sourceLang !== null && never.includes(a.sourceLang)) {
    const matched = fold(a.title).includes(fold(normalizeQuery(query)))
    return {
      main: a.title,
      secondary: translatedTitle !== null && !matched ? translatedTitle : null,
      badge: false,
    }
  }
  const main = translatedTitle ?? a.title
  return {
    main,
    secondary: main !== a.title ? a.title : null,
    badge: translatedTitle !== null && a.sourceLang !== null && a.sourceLang !== readingLang,
  }
}

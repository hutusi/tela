/**
 * Search on the device first: every post in the horizon and every blog the member follows is
 * already here, so the first results need no request. The server adds what is not: older posts
 * and blogs the member does not follow.
 */
import type { ArticleRow, Tables } from '@tela/sync'
import { titleKey } from '@tela/sync'

export type ArticleHit = { article: ArticleRow; translatedTitle: string | null }

const fold = (s: string) => s.toLocaleLowerCase().replace(/\s+/g, ' ')

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
  return hits.sort((x, y) => y.article.id - x.article.id).slice(0, limit)
}

/** The device's hits, then the server's that it did not have, newest first. */
export function mergeHits(local: ArticleHit[], remote: ArticleHit[], limit = 30): ArticleHit[] {
  const seen = new Set(local.map((h) => h.article.id))
  return [...local, ...remote.filter((h) => !seen.has(h.article.id))]
    .sort((x, y) => y.article.id - x.article.id)
    .slice(0, limit)
}

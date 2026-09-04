import { sql } from 'drizzle-orm'
import type { Db } from '../client'

export const SEARCH_QUERY_MAX = 100

/** `%term%` with LIKE metacharacters escaped, so "100%" matches literally. */
export function likePattern(query: string): string {
  return `%${query.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
}

/** Trim, cap, and collapse whitespace; empty means "no search". */
export function normalizeQuery(raw: string | undefined): string {
  return (raw ?? '').replace(/\s+/g, ' ').trim().slice(0, SEARCH_QUERY_MAX)
}

export type ArticleHit = {
  id: number
  feedId: number
  title: string
  /** Title in the reading language when a translation exists. */
  translatedTitle: string | null
  feedTitle: string | null
  siteTitle: string | null
  sourceLang: string | null
  at: Date | null
}

/** Posts from the member's subscriptions whose original or translated title matches. */
export async function searchArticles(
  db: Db,
  opts: { userId: string; query: string; readingLang: string; limit?: number },
): Promise<ArticleHit[]> {
  const query = normalizeQuery(opts.query)
  if (!query) return []
  const pattern = likePattern(query)
  const rows = await db.execute<{
    id: number
    feed_id: number
    title: string
    translated_title: string | null
    feed_title: string | null
    site_title: string | null
    source_lang: string | null
    at: Date | null
  }>(sql`
    select a.id, a.feed_id, a.title, tr.title as translated_title, f.title as feed_title,
           s.title as site_title, a.source_lang, coalesce(a.published_at, a.fetched_at) as at
    from articles a
    join subscriptions sub on sub.feed_id = a.feed_id and sub.user_id = ${opts.userId}
    join feeds f on f.id = a.feed_id
    join sites s on s.id = f.site_id
    left join article_translations tr
      on tr.article_id = a.id and tr.target_lang = ${opts.readingLang}
    where a.title ilike ${pattern} or coalesce(tr.title, '') ilike ${pattern}
    order by a.id desc
    limit ${Math.min(opts.limit ?? 30, 100)}
  `)
  return rows.map((r) => ({
    id: Number(r.id),
    feedId: Number(r.feed_id),
    title: r.title,
    translatedTitle: r.translated_title,
    feedTitle: r.feed_title,
    siteTitle: r.site_title,
    sourceLang: r.source_lang,
    at: r.at ? new Date(r.at) : null,
  }))
}

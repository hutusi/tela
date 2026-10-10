/**
 * The SQL the public answers share (`public.ts`, `discover.ts`): which blogs are public, a reader
 * count as anyone may see it, a post's titles and excerpts in the launch languages, a blog as a
 * Discover card shows it, and the front page's edition. Each is written once, so two answers that
 * show the same post or blog cannot disagree about what it is or whether it may be shown.
 */
import { ARTICLE_COLUMNS, publicReaderCount } from '@tela/data'
import { type SQL, sql } from 'drizzle-orm'

/** Five minutes at the edge, a day of serving stale while it refreshes. */
export const PUBLIC_CACHE = 'public, max-age=60, s-maxage=300, stale-while-revalidate=86400'
/**
 * A profile shows what its member chose to show, and Settings tells them a change reaches it in a
 * few minutes: a browser may serve its copy a minute and four more while it asks again, never a
 * day (ADR 0031). Discover and a blog's page keep PUBLIC_CACHE (ADR 0024).
 */
export const PROFILE_CACHE = 'public, max-age=60, s-maxage=300, stale-while-revalidate=240'
/** A language filter as a query string may give one: a tag, never a pattern or a list. */
export const LANG = /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/
export const DAY = 24 * 60 * 60 * 1000
/** The listings anyone may see, over `sites`: listed and featured (ADR 0041). */
export const PUBLIC_LISTING = sql.raw(`('listed', 'featured')`)
/** A blog's reader count as anyone may see it (`publicReaderCount`), over `sites s`. */
export const READER_COUNT = publicReaderCount('s')
/**
 * A post's titles in the launch languages it has one in, from a table aliased `a`: a public page
 * is cached for everyone, so it carries each and the reader picks the one they read in.
 */
export const TITLES = sql.raw(`(select json_group_object(t.lang, t.title) from article_titles t
  where t.article_id = a.id and t.title is not null) as "titles"`)
/**
 * Beside `TITLES`, a post's excerpts in the launch languages it has one in: the front page's lead
 * shows the translated one when the visitor reads titles translated.
 */
export const EXCERPTS = sql.raw(`(select json_group_object(t.lang, t.excerpt) from article_titles t
  where t.article_id = a.id and t.excerpt is not null) as "excerpts"`)

/** An object SQLite's `json_group_object` handed back as text; anything unreadable is none. */
export function parseLangMap(value: unknown): Record<string, string> {
  if (typeof value !== 'string') return {}
  try {
    return JSON.parse(value) as Record<string, string>
  } catch {
    return {}
  }
}

/** The titles object SQLite handed back as text. */
export function withTitles<T extends Record<string, unknown>>(row: T): T {
  if (typeof row.titles !== 'string') return row
  return { ...row, titles: parseLangMap(row.titles) }
}

/**
 * A public blog as a Discover card shows it, over `sites s`: its reader count as anyone may see
 * it, its first live feed (what Subscribe adds), its newest post's title and date, and how many
 * posts it published since `since`. Never how it was listed (ADR 0041).
 */
export const siteCard = (since: number): SQL => sql`
  s.id, s.title, s.home_url as "homeUrl", s.description, s.favicon_key as "faviconKey",
  s.primary_lang as "primaryLang", (s.claimed_by is not null) as claimed,
  ${READER_COUNT} as "readerCount",
  (select min(f.id) from feeds f where f.site_id = s.id and f.merged_into is null) as "feedId",
  (select a.title from articles a join feeds f on f.id = a.feed_id where f.site_id = s.id
    and f.merged_into is null order by a.sort_at desc limit 1) as "latestTitle",
  (select max(a.sort_at) from articles a join feeds f on f.id = a.feed_id
    where f.site_id = s.id and f.merged_into is null) as "latestAt",
  (select count(*) from articles a join feeds f on f.id = a.feed_id
    where f.site_id = s.id and f.merged_into is null and a.sort_at >= ${since})
    as "postsLast30d"`

/**
 * The front page's edition (ADR 0035): the newest post of each public blog, newest first, 60 at
 * most, with its titles, excerpts, blog and claimant, and `extras` as more columns. The answer
 * keeps the week's (`sortAt` from seven days back) or, when nobody wrote that week, all of them.
 *
 * Each blog's newest post is a seek per live feed down `articles_feed_sort_idx`, then the newest
 * of those: ordering a join of feeds and articles before the limit reads every article the blog
 * has. Future-dated posts wait for their date.
 */
export const editionStatement = (now: number, extras?: SQL): SQL => sql`
  select ${ARTICLE_COLUMNS}, ${TITLES}, ${EXCERPTS},
    s.id as "siteId", s.title as "siteTitle", s.home_url as "homeUrl",
    s.favicon_key as "faviconKey", s.primary_lang as "primaryLang",
    p.handle as "claimantHandle", p.display_name as "claimantName"${extras ? sql`, ${extras}` : sql``}
  from sites s
  join articles a on a.id = (
    select a1.id from feeds f
    join articles a1 on a1.id = (
      select a2.id from articles a2 where a2.feed_id = f.id and a2.sort_at <= ${now}
      order by a2.sort_at desc, a2.id desc limit 1
    )
    where f.site_id = s.id and f.merged_into is null
    order by a1.sort_at desc, a1.id desc limit 1
  )
  left join profiles p on p.user_id = s.claimed_by
  where s.listing in ${PUBLIC_LISTING}
  order by a.sort_at desc, a.id desc
  limit 60
`

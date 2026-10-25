/**
 * The SQL the public answers share (`public.ts`, `discover.ts`, `blogrolls.ts`): which blogs are
 * public, a reader count as anyone may see it, a post's titles and excerpts in the launch
 * languages, a blog as a Discover card shows it, a blogroll as a card shows it, and the front
 * page's edition. Each is written once, so two answers that show the same post or blog cannot
 * disagree about what it is or whether it may be shown.
 */
import {
  ARTICLE_COLUMNS,
  avatarOf,
  BLOG_NAME,
  inDiscover,
  publicReaderCount,
  standingOk,
  visibleBlogCount,
  visibleBlogsFrom,
} from '@tela/data'
import { type SQL, sql } from 'drizzle-orm'

type Row = Record<string, unknown>

/** Five minutes at the edge, a day of serving stale while it refreshes. */
export const PUBLIC_CACHE = 'public, max-age=60, s-maxage=300, stale-while-revalidate=86400'
/**
 * A profile shows what its member chose to show, and Settings tells them a change reaches it in a
 * few minutes: a browser may serve its copy a minute and four more while it asks again, never a
 * day (ADR 0031). Discover's Blogs and a blog's page keep PUBLIC_CACHE (ADR 0024); its other
 * tabs carry recommendations and public subscriptions, so they are cached as a profile is.
 */
export const PROFILE_CACHE = 'public, max-age=60, s-maxage=300, stale-while-revalidate=240'
/**
 * A public answer that has nothing to show: a minute in the browser and at the edge, so a page made
 * public (a blog listed, a blogroll shown) is found within minutes of a visit that missed it.
 */
export function publicNotFound(): Response {
  return new Response(JSON.stringify({ error: 'not_found' }), {
    status: 404,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'public, max-age=60, s-maxage=60',
    },
  })
}

/** A language filter as a query string may give one: a tag, never a pattern or a list. */
export const LANG = /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/
export const DAY = 24 * 60 * 60 * 1000
/** The listings anyone may see, over `sites`: listed and featured (ADR 0041). */
export const PUBLIC_LISTING = sql.raw(`('listed', 'featured')`)
/** A blog's reader count as anyone may see it (`publicReaderCount`), over `sites s`. */
export const READER_COUNT = publicReaderCount('s')

/**
 * Whether search engines may index a public page (ADR 0060). What anyone can publish on Tela is
 * indexed only once someone has vouched for it, so an open sign-up cannot turn telaread.com into
 * a place to rank spam: a claim, three readers or a new account vouch for nothing, being things a
 * spammer can make. The page says `noindex, nofollow` until then (`apps/reader/src/ssr.tsx`), and
 * the sitemap leaves it out.
 *
 * A blog, over `sites s`: public and listed by an operator (List, Feature, curation; ADR 0041).
 * A claimed blog nobody has reviewed is public and not indexed.
 */
export const SITE_INDEXABLE = sql.raw(
  `(s.listing in ('listed', 'featured') and s.review = 'listed')`,
)
/** How long a new account's profile waits before it is indexed: time to report or suspend it. */
export const PROFILE_INDEX_AFTER = 7 * DAY
/** A profile, over `profiles p`: a week old at `now`, and in good standing. */
export const profileIndexable = (now: number, p = 'p'): SQL =>
  sql`(${sql.raw(p)}.created_at <= ${now - PROFILE_INDEX_AFTER} and ${standingOk(p)})`
/**
 * A blogroll, over `blogrolls r` and its owner's `profiles p`: one Discover shows (public, not
 * hidden, with enough blogs others see to be more than a stub), of an owner in good standing.
 */
export const BLOGROLL_INDEXABLE = sql`(${inDiscover('r')} and ${standingOk('p')})`
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

/** A post's blog as a public post list shows it beside the post. */
export type PostSite = {
  id: number
  title: string | null
  homeUrl: string
  faviconKey: string | null
  primaryLang: string | null
  claimed: boolean
}

/** `PostSite`'s columns, over `sites s`, named apart from `ARTICLE_COLUMNS`. */
export const POST_SITE = sql.raw(`s.id as "siteId", s.title as "siteTitle", s.home_url as "homeUrl",
  s.favicon_key as "faviconKey", s.primary_lang as "primaryLang",
  (s.claimed_by is not null) as "siteClaimed"`)

/**
 * A row of `ARTICLE_COLUMNS`, `TITLES` and `POST_SITE` (and `EXCERPTS`, when it was selected) as
 * the post and its blog. Take any other column off the row first: whatever is left is the post's.
 */
export function postOf(row: Row): { article: Row; site: PostSite } {
  const { siteId, siteTitle, homeUrl, faviconKey, primaryLang, siteClaimed, excerpts, ...article } =
    row
  return {
    article:
      excerpts === undefined
        ? withTitles(article)
        : { ...withTitles(article), excerpts: parseLangMap(excerpts) },
    site: {
      id: Number(siteId),
      title: (siteTitle as string | null) ?? null,
      homeUrl: String(homeUrl),
      faviconKey: (faviconKey as string | null) ?? null,
      primaryLang: (primaryLang as string | null) ?? null,
      claimed: siteClaimed === 1,
    },
  }
}

/** How many of a post's recommenders an answer names, newest first. */
export const RECOMMENDERS_SHOWN = 20

/**
 * What readers did with a post, over `articles a`, from its live recommendations: how many were
 * made since `since` (`weekRecs`), who made them, newest first (`recommenders`, a JSON array of at
 * most `RECOMMENDERS_SHOWN` ids), and the newest with a note, with its person (`note`, a JSON
 * object or null). Newest is by id, the order tela-api first received them: `created_at` is the
 * device's `at`, which a device can date back, and a recommendation made again, or with its note
 * changed, keeps its row and so its place. Recommendations are public (ADR 0031), so a cached answer may carry them.
 */
export const postExtras = (since: number): SQL => sql`
  (select count(*) from recommendations r where r.article_id = a.id and r.deleted_at is null
    and r.created_at >= ${since}) as "weekRecs",
  (select json_group_array(x.user_id) from (
    select r.user_id from recommendations r where r.article_id = a.id and r.deleted_at is null
    order by r.id desc limit ${sql.raw(String(RECOMMENDERS_SHOWN))}) x) as "recommenders",
  (select json_object('text', r.note, 'id', p.user_id, 'handle', p.handle,
      'displayName', p.display_name, 'avatar', ${avatarOf('p')})
    from recommendations r join profiles p on p.user_id = r.user_id
    where r.article_id = a.id and r.deleted_at is null and r.note is not null and r.note <> ''
    order by r.id desc limit 1) as "note"`

/**
 * A public blog as a Discover card shows it, over `sites s`: its reader count as anyone may see
 * it, its first live feed (what Subscribe adds), its newest post's title and date, and how many
 * posts it published since `since`, of the posts whose date has come by `now`. Never how it was
 * listed (ADR 0041).
 */
export const siteCard = (since: number, now: number): SQL => sql`
  s.id, s.title, s.home_url as "homeUrl", s.description, s.favicon_key as "faviconKey",
  s.primary_lang as "primaryLang", (s.claimed_by is not null) as claimed,
  ${READER_COUNT} as "readerCount",
  (select min(f.id) from feeds f where f.site_id = s.id and f.merged_into is null) as "feedId",
  (select a.title from articles a join feeds f on f.id = a.feed_id where f.site_id = s.id
    and f.merged_into is null and a.sort_at <= ${now} order by a.sort_at desc limit 1)
    as "latestTitle",
  (select max(a.sort_at) from articles a join feeds f on f.id = a.feed_id
    where f.site_id = s.id and f.merged_into is null and a.sort_at <= ${now}) as "latestAt",
  (select count(*) from articles a join feeds f on f.id = a.feed_id
    where f.site_id = s.id and f.merged_into is null and a.sort_at >= ${since}
      and a.sort_at <= ${now}) as "postsLast30d"`

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

/** A member as a public answer names them (`Person` in the reader's `views/types.ts`). */
export type Person = {
  id: string
  handle: string
  displayName: string | null
  avatar: string | null
}

/**
 * When others last saw a blogroll change, over `blogrolls r` (ADR 0050): the latest of its own
 * clock (name and description) and what its blog rows show them: a blog put in or taken out, a
 * note written on a blog still in. A blog the operator hid is none of theirs, nor a note on one
 * taken out: counted, "Updated today" would tell of a change nobody else can see. Public or
 * private keeps a version, not a clock, and changes nothing others read on the page.
 */
export const BLOGROLL_UPDATED_AT = sql.raw(`max(r.updated_at, coalesce((
    select max(case when b.removed_at is null then max(b.updated_at, b.note_at) else b.updated_at end)
    from blogroll_blogs b join feeds bf on bf.id = b.feed_id join sites bs on bs.id = bf.site_id
    where b.blogroll_id = r.id and bs.listing <> 'rejected'
  ), 0))`)

/** A blog on a blogroll's card: enough to draw its swatch and name it. */
export type BlogrollChip = { feedId: number; siteId: number; name: string | null; homeUrl: string }

/** A blogroll on a profile or Discover (`BlogrollCard` in the reader's `views/types.ts`). */
export type BlogrollCard = {
  id: string
  name: string
  description: string
  owner: Person
  blogCount: number
  blogs: BlogrollChip[]
  publicSince: number | null
  updatedAt: number
}

/**
 * A blogroll as a card shows it, over `blogrolls r` joined to its owner's `profiles p`: how many
 * blogs others see, and the first `chips` of them in the blogroll's order, as one JSON array. The
 * chips are ordered in a subquery and limited before they are aggregated, which keeps that order
 * on libSQL and D1 alike; `json_group_array(… order by …)` needs a newer SQLite than D1 promises.
 */
export const blogrollCard = (chips: number): SQL => sql`
  r.id, r.name, r.description, r.public_since as "publicSince",
  ${BLOGROLL_UPDATED_AT} as "updatedAt", ${visibleBlogCount('r')} as "blogCount",
  (select json_group_array(json_object('feedId', x.feed_id, 'siteId', x.site_id, 'name', x.name,
      'homeUrl', x.home_url))
    from (
      select bb.feed_id, s.id as site_id, ${BLOG_NAME} as name, s.home_url
      from ${visibleBlogsFrom('r')}
      order by bb.added_at, bb.feed_id
      limit ${sql.raw(String(Math.trunc(chips)))}
    ) x) as blogs,
  p.user_id as "ownerId", p.handle as "ownerHandle", p.display_name as "ownerName",
  ${avatarOf('p')} as "ownerAvatar"`

/** A row of `blogrollCard` as the card. */
export function blogrollCardOf(row: Row): BlogrollCard {
  let chips: unknown = []
  try {
    chips = JSON.parse(String(row.blogs ?? '[]'))
  } catch {}
  return {
    id: String(row.id),
    name: String(row.name),
    description: String(row.description ?? ''),
    owner: {
      id: String(row.ownerId),
      handle: String(row.ownerHandle),
      displayName: (row.ownerName as string | null) ?? null,
      avatar: (row.ownerAvatar as string | null) ?? null,
    },
    blogCount: Number(row.blogCount ?? 0),
    blogs: Array.isArray(chips)
      ? chips.map((c: Row) => ({
          feedId: Number(c.feedId),
          siteId: Number(c.siteId),
          name: (c.name as string | null) ?? null,
          homeUrl: String(c.homeUrl),
        }))
      : [],
    publicSince: row.publicSince == null ? null : Number(row.publicSince),
    updatedAt: Number(row.updatedAt),
  }
}

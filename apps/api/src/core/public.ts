/**
 * The public side's reads (ADR 0065): Discover's tabs, a blog's page, a member's profile, a
 * blogroll, and search, as the web's public routes and the API's `/v1` routes both answer them.
 * Each returns a neutral result, never a Response; each surface words it its own way.
 *
 * What may be shown is decided here, once, so no surface can show more: listed and featured blogs
 * only (ADR 0041), a merged feed's posts never (ADR 0028), future-dated posts not before their
 * date, members only in good standing (`standingOk`, ADRs 0058, 0059), subscriptions and likes
 * only where their member shows them (ADR 0031), translated titles never of a blog whose writer
 * turned translation off, a reader count only from three readers up, and nothing that says how a
 * blog was listed.
 *
 * Paged lists take a 1-based `page` and say whether there is `more`; the web's answers leave
 * `more` out, as they always have.
 */
import {
  type Actor,
  ARTICLE_COLUMNS,
  avatarOf,
  BLOG_NAME,
  FEED_COLUMNS,
  inDiscover,
  isShown,
  PUBLIC_ARTICLE_COLUMNS,
  publicReaderCount,
  siteColumns,
  standingOk,
  type TelaDb,
  visibleBlogsFrom,
} from '@tela/data'
import { BLOGROLL_ID, isReadingLanguage, isTopic } from '@tela/shared'
import type { ArticleRow, FeedRow, SiteRow } from '@tela/sync'
import { type SQL, sql } from 'drizzle-orm'
import type { ApiDeps } from '../deps'
import {
  BLOGROLL_UPDATED_AT,
  type BlogrollCard,
  blogrollCard,
  blogrollCardOf,
  blogrollIndexable,
  DAY,
  EXCERPTS,
  editionStatement,
  LANG,
  POST_SITE,
  type PostSite,
  PUBLIC_LISTING,
  postExtras,
  postOf,
  profileIndexable,
  READER_COUNT,
  RECOMMENDERS_SHOWN,
  SITE_INDEXABLE,
  siteCard,
  TITLES,
  withTitles,
} from './public-sql'

type Row = Record<string, unknown>

/**
 * Blogs on one page of Discover's Blogs. The directory outgrew one page when the editorial list
 * reached 110, and a bare `limit` dropped the newest blogs from All with nothing to say so.
 */
export const DISCOVER_PAGE = 60
/** Posts on one page of Articles. */
export const ARTICLES_PAGE = 30
/** Blogrolls on one page of Blogrolls, and the blogs each card names. */
export const BLOGROLLS_PAGE = 30
export const DISCOVER_CARD_BLOGS = 5
/** Recommended posts in This week and on Articles' first page, and posts of This week's edition. */
export const WEEK_POSTS = 30
/** Blogs new in the directory, in This week. */
export const NEW_BLOGS = 12
/** People in Readers' pool, and how many of each one's recommendations come with them. */
export const READERS_POOL = 100
export const RECS_PER_READER = 50
/** The same, for This week's few readers to follow. */
export const READERS_IN_WEEK = 40
export const RECS_IN_WEEK = 20
/**
 * How many recommended a post after someone for it to be their early find. From two, so that at
 * two members nobody is "first, before one other".
 */
export const EARLY_MIN = 2
/** Posts on one page of a blog's page. */
export const SITE_POSTS_PAGE = 20
/** Recommendations, and liked posts, on one page of a profile. */
export const PROFILE_POSTS_PAGE = 100
/** Blogs a blogroll's card on a profile names, in the blogroll's order. */
export const PROFILE_CARD_BLOGS = 3
/** How much of a blog's own description a blogroll's row shows: a tagline, not its About. */
export const BLOG_DESCRIPTION_MAX = 300
/** Search's posts on one page, and the blogs it names. */
export const SEARCH_POSTS_PAGE = 30
export const SEARCH_SITES = 12
/** The last page any list may be asked for. */
export const MAX_PAGE = 1000

export { RECOMMENDERS_SHOWN }

/** A page number as a query may give one: 1 unless a whole number from 2 to `MAX_PAGE`. */
export function pageOf(asked: unknown): number {
  const n = Number(asked)
  return Number.isInteger(n) && n > 1 && n <= MAX_PAGE ? n : 1
}

export type Person = {
  id: string
  handle: string
  displayName: string | null
  avatar: string | null
}
export type DiscoverPost = {
  article: Row
  site: PostSite
  weekRecs: number
  recommenders: string[]
  note: { text: string; person: Person } | null
}
export type ReaderPost = { article: Row; site: PostSite }
export type ReaderCandidate = Person & {
  bio: string | null
  recs: [number, number][]
  sites: number[] | null
  recent: number
  withNote: number
  total: number
  early: (ReaderPost & { others: number }) | null
  sample: (ReaderPost & { note: string }) | null
}

/** A cursor into Articles: the last post shown's `sortAt:id`. */
const CURSOR = /^(-?\d{1,15}):(\d{1,12})$/
/** A cursor into Blogrolls: the last blogroll shown's `publicSince:id`. */
const BLOGROLLS_CURSOR = /^(\d{1,15}):([A-Za-z0-9]{12})$/

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return null
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

/** A row of the post columns and `postExtras` as a post Discover lists. */
function discoverPost(row: Row): DiscoverPost {
  const { weekRecs, recommenders, note, ...rest } = row
  const ids = parseJson(recommenders)
  const given = parseJson(note) as Row | null
  return {
    ...postOf(rest),
    weekRecs: Number(weekRecs ?? 0),
    recommenders: Array.isArray(ids)
      ? ids.filter((id): id is string => typeof id === 'string').slice(0, RECOMMENDERS_SHOWN)
      : [],
    note:
      given && typeof given.text === 'string' && typeof given.id === 'string'
        ? {
            text: given.text,
            person: {
              id: given.id,
              handle: String(given.handle),
              displayName: (given.displayName as string | null) ?? null,
              avatar: (given.avatar as string | null) ?? null,
            },
          }
        : null,
  }
}

/**
 * Posts on public blogs recommended between `since` and `now`, the most recommended first, then
 * the newest; `filters` narrows them further, over `articles a` and `sites s`.
 */
const recommendedStatement = (now: number, since: number, filters: SQL, limit: number) => sql`
  select ${PUBLIC_ARTICLE_COLUMNS}, ${TITLES}, ${EXCERPTS}, ${POST_SITE}, ${postExtras(since)}
  from (select rr.article_id, count(*) as n from recommendations rr
        join profiles rp on rp.user_id = rr.user_id
        where rr.deleted_at is null and rr.created_at >= ${since} and rr.created_at <= ${now}
          and ${standingOk('rp')}
        group by rr.article_id) w
  join articles a on a.id = w.article_id
  join feeds f on f.id = a.feed_id and f.merged_into is null
  join sites s on s.id = f.site_id
  where s.listing in ${PUBLIC_LISTING} and a.sort_at <= ${now} ${filters}
  order by w.n desc, a.sort_at desc, a.id desc
  limit ${limit}
`

/**
 * The people Discover may suggest, and what each answer needs to suggest them: everyone who
 * recommends, and everyone who shows their subscriptions and reads a public blog (ADR 0031's
 * public signals, and nothing else), the most active of late first, `caps.people` of them. Each
 * comes with their newest `caps.recs` recommendations as `[articleId, siteId]`, the public blogs
 * they read if they show them, their earliest find (the post they recommended before the most
 * others did, from `EARLY_MIN` up) and their newest note on a public blog's post.
 *
 * Only people whose profile is indexed (`profileIndexable`: a week old, in good standing): Readers
 * and This week are indexed pages that name each person, with their bio and a note, and a new
 * account must not reach them before its own profile would (ADR 0060).
 *
 * Two round trips, as a profile takes: the pool, then one batch keyed by its ids through one JSON
 * parameter. "Before" is by recommendation id, never `created_at`: that is the device's `at`, which
 * the push clamps only from above, so a backdated one would make anyone early.
 */
export async function readersPool(
  db: TelaDb,
  now: number,
  caps: { people: number; recs: number },
): Promise<ReaderCandidate[]> {
  const recent = now - 30 * DAY
  const [pool] = (await db.batch([
    db.all(sql`
      select p.user_id as id, p.handle, p.display_name as "displayName", p.bio,
        ${avatarOf('p')} as avatar, p.public_subscriptions as "publicSubscriptions",
        (select count(*) from recommendations r where r.user_id = p.user_id
          and r.deleted_at is null and r.created_at >= ${recent}) as recent,
        (select count(*) from recommendations r where r.user_id = p.user_id
          and r.deleted_at is null and r.created_at >= ${recent}
          and r.note is not null and r.note <> '') as "withNote",
        (select count(*) from recommendations r where r.user_id = p.user_id
          and r.deleted_at is null) as total
      from profiles p
      where ${profileIndexable(now)} and (exists (select 1 from recommendations r
          where r.user_id = p.user_id and r.deleted_at is null)
        or (p.public_subscriptions = 1 and exists (
          select 1 from subscriptions sub join feeds f on f.id = sub.feed_id
          join sites s on s.id = f.site_id
          where sub.user_id = p.user_id and sub.deleted_at is null
            and s.listing in ${PUBLIC_LISTING})))
      order by recent desc, total desc, p.handle
      limit ${caps.people}
    `),
  ] as never)) as unknown as Row[][]
  if (!pool?.length) return []

  const ids = JSON.stringify(pool.map((p) => String(p.id)))
  const inPool = (column: SQL) => sql`${column} in (select value from json_each(${ids}))`
  const [recs, sites, early, sample] = (await db.batch([
    // Ids only, of any blog: a profile already lists them all.
    db.all(sql`
      select x.user_id as "userId", x.article_id as "articleId", x.site_id as "siteId" from (
        select r.user_id, r.article_id, f.site_id,
          row_number() over (partition by r.user_id order by r.id desc) as k
        from recommendations r join articles a on a.id = r.article_id
        join feeds f on f.id = a.feed_id
        where r.deleted_at is null and ${inPool(sql`r.user_id`)}
      ) x where x.k <= ${caps.recs}
      order by x.user_id, x.k
    `),
    // As the Following feed shows them: only from people who show them, only public blogs.
    db.all(sql`
      select distinct sub.user_id as "userId", f.site_id as "siteId"
      from subscriptions sub join profiles p on p.user_id = sub.user_id
      join feeds f on f.id = sub.feed_id join sites s on s.id = f.site_id
      where ${inPool(sql`sub.user_id`)} and p.public_subscriptions = 1
        and sub.deleted_at is null and s.listing in ${PUBLIC_LISTING}
      order by sub.user_id, f.site_id
    `),
    db.all(sql`
      with mine as (
        select r.user_id, r.article_id, r.id,
          (select count(*) from recommendations o where o.article_id = r.article_id
            and o.deleted_at is null and o.id > r.id) as later
        from recommendations r join articles a on a.id = r.article_id
        join feeds f on f.id = a.feed_id and f.merged_into is null
        join sites s on s.id = f.site_id and s.listing in ${PUBLIC_LISTING}
        where r.deleted_at is null and a.sort_at <= ${now} and ${inPool(sql`r.user_id`)}
      ), ranked as (
        select mine.*, row_number() over (partition by user_id order by later desc, id desc) as k
        from mine where later >= ${sql.raw(String(EARLY_MIN))}
      )
      select ranked.user_id as "userId", ranked.later as others, ${PUBLIC_ARTICLE_COLUMNS}, ${TITLES},
        ${POST_SITE}
      from ranked join articles a on a.id = ranked.article_id
      join feeds f on f.id = a.feed_id join sites s on s.id = f.site_id
      where ranked.k = 1
    `),
    db.all(sql`
      select x.user_id as "userId", x.note, ${PUBLIC_ARTICLE_COLUMNS}, ${TITLES}, ${POST_SITE}
      from (
        select r.user_id, r.article_id, r.note,
          row_number() over (partition by r.user_id order by r.id desc) as k
        from recommendations r join articles a on a.id = r.article_id
        join feeds f on f.id = a.feed_id and f.merged_into is null
        join sites s on s.id = f.site_id and s.listing in ${PUBLIC_LISTING}
        where r.deleted_at is null and r.note is not null and r.note <> ''
          and a.sort_at <= ${now} and ${inPool(sql`r.user_id`)}
      ) x join articles a on a.id = x.article_id
      join feeds f on f.id = a.feed_id join sites s on s.id = f.site_id
      where x.k = 1
    `),
  ] as never)) as unknown as Row[][]

  const recsOf = new Map<string, [number, number][]>()
  for (const r of recs ?? []) {
    const id = String(r.userId)
    recsOf.set(id, [...(recsOf.get(id) ?? []), [Number(r.articleId), Number(r.siteId)]])
  }
  const sitesOf = new Map<string, number[]>()
  for (const r of sites ?? []) {
    const id = String(r.userId)
    sitesOf.set(id, [...(sitesOf.get(id) ?? []), Number(r.siteId)])
  }
  const earlyOf = new Map<string, ReaderPost & { others: number }>()
  for (const { userId, others, ...post } of early ?? []) {
    earlyOf.set(String(userId), { ...postOf(post), others: Number(others) })
  }
  const sampleOf = new Map<string, ReaderPost & { note: string }>()
  for (const { userId, note, ...post } of sample ?? []) {
    sampleOf.set(String(userId), { ...postOf(post), note: String(note) })
  }

  return pool.map((p) => {
    const id = String(p.id)
    return {
      id,
      handle: String(p.handle),
      displayName: (p.displayName as string | null) ?? null,
      avatar: (p.avatar as string | null) ?? null,
      bio: (p.bio as string | null) ?? null,
      recs: recsOf.get(id) ?? [],
      sites: p.publicSubscriptions === 1 ? (sitesOf.get(id) ?? []) : null,
      recent: Number(p.recent ?? 0),
      withNote: Number(p.withNote ?? 0),
      total: Number(p.total ?? 0),
      early: earlyOf.get(id) ?? null,
      sample: sampleOf.get(id) ?? null,
    }
  })
}

export type DiscoverTab = 'week' | 'articles' | 'blogs' | 'blogrolls' | 'readers'
export const DISCOVER_TABS: readonly DiscoverTab[] = [
  'week',
  'articles',
  'blogs',
  'blogrolls',
  'readers',
]

/**
 * What narrows a tab: a topic and a language (Blogs and Articles), and where a page starts: a
 * 1-based `page`, or for Articles and Blogrolls the `cursor` the page before ended at, which
 * repeats and skips nothing while posts arrive (the web pages by it).
 */
export type DiscoverQuery = {
  topic?: string | undefined
  lang?: string | undefined
  page?: number | undefined
  cursor?: string | undefined
}

/** Discover's Blogs: one page of public blogs, the languages they are in, and how many match. */
export type BlogsPage = {
  sites: Row[]
  languages: { lang: string; count: number }[]
  total: number
  page: number
  pageSize: number
}
/** This week (ADR 0044). */
export type WeekPage = {
  since: number
  recommended: DiscoverPost[]
  edition: { span: 'week' | 'latest'; posts: DiscoverPost[] }
  newBlogs: Row[]
  readers: ReaderCandidate[]
}
/** Articles: a page of public posts, newest first; `next` is the cursor to the next, if any. */
export type ArticlesPage = {
  recommended: DiscoverPost[]
  posts: DiscoverPost[]
  next: string | null
  languages: { lang: string; count: number }[]
}
/** Blogrolls (ADR 0050): a page of public blogrolls, newest made public first. */
export type BlogrollsPage = { blogrolls: BlogrollCard[]; next: string | null }
export type ReadersPage = { readers: ReaderCandidate[] }

export type DiscoverPages = {
  week: WeekPage
  articles: ArticlesPage
  blogs: BlogsPage
  blogrolls: BlogrollsPage
  readers: ReadersPage
}

/** One of Discover's tabs, the same for everyone who asks. */
export async function readDiscover<T extends DiscoverTab>(
  deps: Pick<ApiDeps, 'db' | 'clock'>,
  tab: T,
  query: DiscoverQuery = {},
): Promise<DiscoverPages[T]> {
  const read: { [K in DiscoverTab]: () => Promise<DiscoverPages[K]> } = {
    week: () => readWeek(deps),
    articles: () => readArticles(deps, query),
    blogs: () => readBlogs(deps, query),
    blogrolls: () => readBlogrolls(deps, query),
    readers: async () => ({
      readers: await readersPool(deps.db, deps.clock.now(), {
        people: READERS_POOL,
        recs: RECS_PER_READER,
      }),
    }),
  }
  return read[tab]() as Promise<DiscoverPages[T]>
}

/**
 * Discover's Blogs: listed and featured blogs, featured first, then claimed, then by readers, a
 * page at a time; a topic and a language narrow them, and the languages offered.
 */
async function readBlogs(
  { db, clock }: Pick<ApiDeps, 'db' | 'clock'>,
  query: DiscoverQuery,
): Promise<BlogsPage> {
  const { topic, lang } = query
  const byTopic = isTopic(topic)
    ? sql`and exists (select 1 from site_topics t where t.site_id = s.id and t.topic = ${topic})`
    : sql``
  const byLang = lang && LANG.test(lang) ? sql`and s.primary_lang = ${lang}` : sql``
  const page = pageOf(query.page)
  const now = clock.now()
  const since = now - 30 * DAY
  const [sites, languages, topics, totals] = (await db.batch([
    db.all(sql`
      select ${siteCard(since, now)}
      from sites s
      where s.listing in ${PUBLIC_LISTING} ${byTopic} ${byLang}
      order by s.listing = 'featured' desc, s.claimed_by is not null desc,
        coalesce(${READER_COUNT}, 0) desc, s.id
      limit ${DISCOVER_PAGE} offset ${(page - 1) * DISCOVER_PAGE}
    `),
    db.all(sql`
      select s.primary_lang as lang, count(*) as count from sites s
      where s.listing in ${PUBLIC_LISTING} and s.primary_lang is not null ${byTopic}
      group by s.primary_lang order by count desc
    `),
    db.all(sql`
      select t.site_id as "siteId", t.topic from site_topics t
      join sites s on s.id = t.site_id where s.listing in ${PUBLIC_LISTING}
    `),
    db.all(sql`
      select count(*) as total from sites s
      where s.listing in ${PUBLIC_LISTING} ${byTopic} ${byLang}
    `),
  ] as never)) as unknown as [
    Row[],
    { lang: string; count: number }[],
    { siteId: number; topic: string }[],
    { total: number }[],
  ]
  return {
    sites: sites.map((s) => ({
      ...s,
      claimed: s.claimed === 1,
      topics: topics.filter((t) => t.siteId === s.id).map((t) => t.topic),
    })),
    languages,
    total: Number(totals[0]?.total ?? 0),
    page,
    pageSize: DISCOVER_PAGE,
  }
}

/**
 * This week: the rolling seven days' most recommended posts; the front page's edition, for when
 * there are too few (the device decides, since only it knows which blogs to hide); blogs new in
 * the directory; and readers to suggest.
 *
 * A new blog is any listed blog, by when Tela first saw it or its writer claimed it, which a
 * blog's public id already says: never by `reviewed_at`, and never only some doors. Leaving out
 * the blogs an operator listed from the review queue would say which those are, and so that a
 * member reads them, by their absence (ADR 0041).
 */
async function readWeek({ db, clock }: Pick<ApiDeps, 'db' | 'clock'>): Promise<WeekPage> {
  const now = clock.now()
  const since = now - 7 * DAY
  const [[recommended, edition, newBlogs], readers] = await Promise.all([
    db.batch([
      db.all(recommendedStatement(now, since, sql``, WEEK_POSTS)),
      db.all(
        editionStatement(
          now,
          sql`(s.claimed_by is not null) as "siteClaimed", ${postExtras(since)}`,
        ),
      ),
      // The blogs first, then the cards of those only: a card is five subqueries.
      db.all(sql`
        select ${siteCard(now - 30 * DAY, now)},
          (select json_group_array(x.topic) from (
            select t.topic from site_topics t where t.site_id = s.id order by t.topic) x)
            as topics
        from (
          select s.id, max(s.created_at, coalesce(s.claimed_at, 0)) as arrived from sites s
          where s.listing in ${PUBLIC_LISTING}
          order by arrived desc, s.id desc
          limit ${NEW_BLOGS}
        ) n join sites s on s.id = n.id
        order by n.arrived desc, s.id desc
      `),
    ] as never) as unknown as Promise<Row[][]>,
    readersPool(db, now, { people: READERS_IN_WEEK, recs: RECS_IN_WEEK }),
  ])
  // As the front page decides it: the week's posts when the week has any, else the latest.
  const rows = (edition ?? []).map(({ claimantHandle: _h, claimantName: _n, ...row }) => row)
  const week = rows.filter((r) => Number(r.sortAt) >= since)
  const span = week.length > 0 ? 'week' : 'latest'
  return {
    since,
    recommended: (recommended ?? []).map(discoverPost),
    edition: {
      span,
      posts: (span === 'week' ? week : rows).slice(0, WEEK_POSTS).map(discoverPost),
    },
    newBlogs: (newBlogs ?? []).map(({ topics, ...s }) => {
      const list = parseJson(topics)
      return {
        ...s,
        claimed: s.claimed === 1,
        topics: Array.isArray(list) ? list.filter((t) => typeof t === 'string') : [],
      }
    }),
    readers,
  }
}

/**
 * Articles: every public post, newest first, a page at a time behind a `sortAt:id` cursor, cut by
 * key and never by offset, so a post written meanwhile repeats or skips nothing (or by `page`,
 * offset, where no cursor is given); on the first page only, the week's most recommended, whole,
 * since their counts move between pages; and the languages posts were written in over 90 days. A
 * topic narrows all three, a language all but the languages.
 */
async function readArticles(
  { db, clock }: Pick<ApiDeps, 'db' | 'clock'>,
  query: DiscoverQuery,
): Promise<ArticlesPage> {
  const now = clock.now()
  const since = now - 7 * DAY
  const { topic, lang } = query
  const byTopic = isTopic(topic)
    ? sql`and exists (select 1 from site_topics t where t.site_id = s.id and t.topic = ${topic})`
    : sql``
  const byLang = lang && LANG.test(lang) ? sql`and a.source_lang = ${lang}` : sql``
  const cursor = CURSOR.exec(query.cursor ?? '')
  const page = cursor ? 1 : pageOf(query.page)
  const after = cursor
    ? sql`and (a.sort_at, a.id) < (${Number(cursor[1])}, ${Number(cursor[2])})`
    : sql``
  const first = !cursor && page === 1
  const [posts, recommended, languages] = (await db.batch([
    db.all(sql`
      select ${PUBLIC_ARTICLE_COLUMNS}, ${TITLES}, ${EXCERPTS}, ${POST_SITE}, ${postExtras(since)}
      from articles a
      join feeds f on f.id = a.feed_id and f.merged_into is null
      join sites s on s.id = f.site_id
      where s.listing in ${PUBLIC_LISTING} and a.sort_at <= ${now} ${byTopic} ${byLang} ${after}
      order by a.sort_at desc, a.id desc
      limit ${ARTICLES_PAGE + 1} offset ${(page - 1) * ARTICLES_PAGE}
    `),
    first
      ? db.all(recommendedStatement(now, since, sql`${byTopic} ${byLang}`, WEEK_POSTS))
      : db.all(sql`select 1 where false`),
    db.all(sql`
      select a.source_lang as lang, count(*) as count
      from articles a
      join feeds f on f.id = a.feed_id and f.merged_into is null
      join sites s on s.id = f.site_id
      where s.listing in ${PUBLIC_LISTING} and a.source_lang is not null
        and a.sort_at >= ${now - 90 * DAY} and a.sort_at <= ${now} ${byTopic}
      group by a.source_lang order by count desc, lang
    `),
  ] as never)) as unknown as Row[][]
  const shown = (posts ?? []).slice(0, ARTICLES_PAGE)
  const last = shown.at(-1)
  return {
    recommended: first ? (recommended ?? []).map(discoverPost) : [],
    posts: shown.map(discoverPost),
    next: (posts ?? []).length > ARTICLES_PAGE && last ? `${last.sortAt}:${last.id}` : null,
    languages: (languages ?? []).map((l) => ({ lang: String(l.lang), count: Number(l.count) })),
  }
}

/**
 * Blogrolls: every public blogroll with enough blogs others see (`inDiscover`), the newest made
 * public first, a page at a time behind a `publicSince:id` cursor, cut by key and never by
 * offset (or by `page` where no cursor is given). `public_since` is when a blogroll first went
 * public, never moved or cleared: one made public meanwhile goes before the first page, and one
 * made private meanwhile moves no other, so nothing already listed repeats and nothing is skipped.
 * A blogroll the operator hid is left out here only; its page and its place on its member's
 * profile stay.
 */
async function readBlogrolls(
  { db }: Pick<ApiDeps, 'db'>,
  query: DiscoverQuery,
): Promise<BlogrollsPage> {
  const cursor = BLOGROLLS_CURSOR.exec(query.cursor ?? '')
  const page = cursor ? 1 : pageOf(query.page)
  const after = cursor
    ? sql`and (r.public_since, r.id) < (${Number(cursor[1])}, ${cursor[2]})`
    : sql``
  // `public_since is not null` is what a public blogroll always has; without it, a row that
  // somehow lacked one could not be paged past.
  const rows = await db.all<Row>(sql`
    select ${blogrollCard(DISCOVER_CARD_BLOGS)}
    from blogrolls r join profiles p on p.user_id = r.user_id
    where ${inDiscover('r')} and ${standingOk('p')} and r.public_since is not null ${after}
    order by r.public_since desc, r.id desc
    limit ${BLOGROLLS_PAGE + 1} offset ${(page - 1) * BLOGROLLS_PAGE}
  `)
  const shown = rows.slice(0, BLOGROLLS_PAGE).map(blogrollCardOf)
  const last = shown.at(-1)
  return {
    blogrolls: shown,
    next: rows.length > BLOGROLLS_PAGE && last ? `${last.publicSince}:${last.id}` : null,
  }
}

/** A public blog's page: the blog, its feeds, a page of its posts, its topics and readers' notes. */
export type SitePage = {
  site: Row & { indexable: boolean; claimant: Row | null }
  feeds: Row[]
  posts: Row[]
  topics: string[]
  notes: { note: unknown; createdAt: unknown; person: Row; article: Row }[]
  /** Whether a later page of posts has any. */
  more: boolean
}

/**
 * A public blog's page, or null for a blog nobody may see (not listed or featured, or none at
 * all). Its posts newest first, `SITE_POSTS_PAGE` a page; its readers' notes on its posts, from
 * members in good standing.
 */
export async function readSitePage(
  deps: Pick<ApiDeps, 'db' | 'clock'>,
  siteId: number,
  page = 1,
): Promise<SitePage | null> {
  const { db } = deps
  if (!Number.isInteger(siteId)) return null
  const at = pageOf(page)
  const since = deps.clock.now() - 30 * DAY
  const [sites, feeds, posts, topics, notes] = (await db.batch([
    db.all(sql`
      select s.id, s.title, s.home_url as "homeUrl", s.description, s.favicon_key as "faviconKey",
        s.primary_lang as "primaryLang", ${READER_COUNT} as "readerCount",
        ${SITE_INDEXABLE} as indexable, p.handle as "claimedBy", p.display_name as "claimantName", p.bio as "claimantBio",
        ${avatarOf('p')} as "claimantAvatar",
        (select count(*) from articles a join feeds f on f.id = a.feed_id
          where f.site_id = s.id and f.merged_into is null and a.sort_at >= ${since})
          as "postsLast30d"
      from sites s left join profiles p on p.user_id = s.claimed_by and ${standingOk('p')}
      where s.id = ${siteId} and s.listing in ${PUBLIC_LISTING}
    `),
    db.all(sql`
      select f.id, f.feed_url as "feedUrl", f.title from feeds f
      join sites s on s.id = f.site_id
      where f.site_id = ${siteId} and f.merged_into is null and s.listing in ${PUBLIC_LISTING}
      order by f.id
    `),
    // Posts as the reader holds them, so a member can open one from here. A merged feed's
    // posts are duplicates of its target's (ADR 0028).
    db.all(sql`
      select ${PUBLIC_ARTICLE_COLUMNS}, ${TITLES}
      from articles a join feeds f on f.id = a.feed_id join sites s on s.id = f.site_id
      where f.site_id = ${siteId} and f.merged_into is null and s.listing in ${PUBLIC_LISTING}
      order by a.sort_at desc, a.id desc
      limit ${SITE_POSTS_PAGE + 1} offset ${(at - 1) * SITE_POSTS_PAGE}
    `),
    db.all(sql`select topic from site_topics where site_id = ${siteId}`),
    // What readers said recommending its posts: recommendations are public (ADR 0031).
    db.all(sql`
      select r.note, r.created_at as "createdAt", p.user_id as "userId", p.handle,
        p.display_name as "displayName", ${PUBLIC_ARTICLE_COLUMNS}, ${TITLES}
      from recommendations r join articles a on a.id = r.article_id
      join feeds f on f.id = a.feed_id join sites s on s.id = f.site_id
      join profiles p on p.user_id = r.user_id
      where f.site_id = ${siteId} and s.listing in ${PUBLIC_LISTING} and ${standingOk('p')}
        and r.deleted_at is null and r.note is not null and r.note <> ''
      order by r.created_at desc limit 5
    `),
  ] as never)) as unknown as Row[][]
  const row = sites?.[0]
  if (!row) return null
  const { claimantName, claimantBio, claimantAvatar, indexable, ...site } = row
  return {
    site: {
      ...site,
      // Whether search engines may index its page (ADR 0060).
      indexable: indexable === 1,
      // Who writes it, for the page's About: the claimant's own name and bio.
      claimant: site.claimedBy
        ? {
            handle: site.claimedBy,
            displayName: claimantName,
            bio: claimantBio,
            avatar: claimantAvatar,
          }
        : null,
    },
    feeds: feeds ?? [],
    posts: (posts ?? []).slice(0, SITE_POSTS_PAGE).map(withTitles),
    topics: (topics ?? []).map((t) => String(t.topic)),
    notes: (notes ?? []).map((n) => {
      const { note, createdAt, userId, handle, displayName, ...article } = n
      return {
        note,
        createdAt,
        // The account id: what a report of the note names (ADR 0059).
        person: { id: userId, handle, displayName },
        article: withTitles(article),
      }
    }),
    more: (posts ?? []).length > SITE_POSTS_PAGE,
  }
}

/** A post on a profile: the article, its blog, and whether that blog has a public page. */
export type ProfilePost = {
  siteId: unknown
  siteTitle: unknown
  homeUrl: unknown
  listed: boolean
  vouched: boolean
  article: Row
} & ({ note: unknown; createdAt: unknown } | { likedAt: unknown })

/** A member's public profile, as far as they chose to show it. */
export type ProfilePage = {
  profile: {
    id: string
    handle: string
    displayName: string | null
    bio: string | null
    avatar: string | null
    memberSince: number
    indexable: boolean
  }
  counts: {
    following: number
    followers: number
    recommendations: number
    liked: number | null
    subscriptions: number | null
  }
  blogs: Row[]
  recommendations: ProfilePost[]
  /** Null unless they show what they read. */
  subscriptions: Row[] | null
  /** Null unless they show what they liked. */
  liked: ProfilePost[] | null
  blogrolls: BlogrollCard[]
  /** Whether a later page has more recommendations, or more liked posts. */
  more: { recommendations: boolean; liked: boolean }
}

/**
 * A member's public profile by handle, or null for none, or one out of good standing: their
 * blogs, recommendations (`PROFILE_POSTS_PAGE` a page), what they read and what they liked only
 * if they show them (ADR 0031), the counts, and their public blogrolls.
 */
export async function readProfile(
  deps: Pick<ApiDeps, 'db' | 'clock'>,
  handle: string,
  page = 1,
): Promise<ProfilePage | null> {
  const { db } = deps
  const at = pageOf(page)
  const offset = (at - 1) * PROFILE_POSTS_PAGE
  const profile = (
    await db.all<{
      user_id: string
      handle: string
      display_name: string | null
      bio: string | null
      created_at: number
      public_subscriptions: number
      public_likes: number
      avatar: string | null
      indexable: number
    }>(
      sql`select user_id, handle, display_name, bio, created_at, public_subscriptions, public_likes,
            ${avatarOf('p')} as avatar, ${profileIndexable(deps.clock.now())} as indexable
          from profiles p where handle = ${handle.toLowerCase()} and ${standingOk('p')}`,
    )
  )[0]
  if (!profile) return null
  const id = profile.user_id
  const none = sql`select 1 where false`
  const [blogs, recommendations, subscriptions, liked, counts, blogrolls] = (await db.batch([
    db.all(sql`
      select id, title, home_url as "homeUrl", favicon_key as "faviconKey" from sites
      where claimed_by = ${id} and listing in ${PUBLIC_LISTING} order by title
    `),
    db.all(sql`
      select r.note, r.created_at as "createdAt", s.id as "siteId", s.title as "siteTitle",
        s.home_url as "homeUrl", (s.listing in ${PUBLIC_LISTING}) as listed,
        ${SITE_INDEXABLE} as vouched, ${PUBLIC_ARTICLE_COLUMNS}, ${TITLES}
      from recommendations r join articles a on a.id = r.article_id
      join feeds f on f.id = a.feed_id join sites s on s.id = f.site_id
      where r.user_id = ${id} and r.deleted_at is null
      order by r.created_at desc limit ${PROFILE_POSTS_PAGE + 1} offset ${offset}
    `),
    profile.public_subscriptions
      ? db.all(sql`
          select distinct s.id, s.title, s.home_url as "homeUrl", s.description,
            s.favicon_key as "faviconKey", (s.listing in ${PUBLIC_LISTING}) as listed
          from subscriptions sub join feeds f on f.id = sub.feed_id join sites s on s.id = f.site_id
          where sub.user_id = ${id} and sub.deleted_at is null order by s.title
        `)
      : db.all(none),
    // Liked posts only if the member shows them (ADR 0031).
    profile.public_likes
      ? db.all(sql`
          select st.liked_at as "likedAt", s.id as "siteId", s.title as "siteTitle",
            s.home_url as "homeUrl", (s.listing in ${PUBLIC_LISTING}) as listed,
            ${SITE_INDEXABLE} as vouched, ${PUBLIC_ARTICLE_COLUMNS}, ${TITLES}
          from user_article_states st join articles a on a.id = st.article_id
          join feeds f on f.id = a.feed_id join sites s on s.id = f.site_id
          where st.user_id = ${id} and st.liked_at is not null
          order by st.liked_at desc limit ${PROFILE_POSTS_PAGE + 1} offset ${offset}
        `)
      : db.all(none),
    db.all(sql`
      select
        (select count(*) from follows fo join profiles fp on fp.user_id = fo.followee_id
          where fo.follower_id = ${id} and fo.deleted_at is null and ${standingOk('fp')})
          as following,
        (select count(*) from follows fo join profiles fp on fp.user_id = fo.follower_id
          where fo.followee_id = ${id} and fo.deleted_at is null and ${standingOk('fp')})
          as followers,
        (select count(*) from recommendations where user_id = ${id} and deleted_at is null)
          as recommendations,
        (select count(*) from user_article_states where user_id = ${id} and liked_at is not null)
          as liked
    `),
    // Every public blogroll (ADR 0050), the ones the operator hid from Discover too: Hide takes
    // a blogroll out of Discover, not off its member's profile.
    db.all(sql`
      select ${blogrollCard(PROFILE_CARD_BLOGS)}
      from blogrolls r join profiles p on p.user_id = r.user_id
      where r.user_id = ${id} and ${isShown('r')}
      order by r.created_at desc, r.id desc
    `),
  ] as never)) as unknown as Row[][]
  const count = counts?.[0] ?? {}
  const shownSubscriptions = profile.public_subscriptions
    ? (subscriptions ?? []).map((s) => ({ ...s, listed: s.listed === 1 }))
    : null
  // The post as the reader holds one, beside the note (or when it was liked) and its blog.
  const withArticle = (r: Row): ProfilePost => {
    const { note, createdAt, likedAt, siteId, siteTitle, homeUrl, listed, vouched, ...article } = r
    return {
      ...(likedAt === undefined ? { note, createdAt } : { likedAt }),
      siteId,
      siteTitle,
      homeUrl,
      listed: listed === 1,
      // An operator listed the blog: the post's link is followed (ADR 0060).
      vouched: vouched === 1,
      article: withTitles(article),
    }
  }
  const recs = recommendations ?? []
  const likes = liked ?? []
  return {
    profile: {
      // The account id: what a follow names (ADR 0031). It grants nothing on its own.
      id,
      handle: profile.handle,
      displayName: profile.display_name,
      bio: profile.bio,
      avatar: profile.avatar,
      memberSince: profile.created_at,
      // Whether search engines may index it (ADR 0060).
      indexable: profile.indexable === 1,
    },
    counts: {
      following: Number(count.following ?? 0),
      followers: Number(count.followers ?? 0),
      recommendations: Number(count.recommendations ?? 0),
      liked: profile.public_likes ? Number(count.liked ?? 0) : null,
      subscriptions: shownSubscriptions ? shownSubscriptions.length : null,
    },
    blogs: blogs ?? [],
    recommendations: recs.slice(0, PROFILE_POSTS_PAGE).map(withArticle),
    // The member chose to show what they read; a private blog shows no link to its page.
    subscriptions: shownSubscriptions,
    liked: profile.public_likes ? likes.slice(0, PROFILE_POSTS_PAGE).map(withArticle) : null,
    blogrolls: (blogrolls ?? []).map(blogrollCardOf),
    more: {
      recommendations: recs.length > PROFILE_POSTS_PAGE,
      liked: profile.public_likes === 1 && likes.length > PROFILE_POSTS_PAGE,
    },
  }
}

/** A public blogroll's page (ADR 0050): its blogs in the order they were put in. */
export type BlogrollPage = {
  blogroll: { id: string; name: string; description: string; updatedAt: number; indexable: boolean }
  owner: Person
  blogs: {
    feedId: number
    siteId: number
    name: string | null
    homeUrl: string
    faviconKey: string | null
    primaryLang: string | null
    description: string | null
    listed: boolean
    readerCount: number | null
    dead: boolean
    note: string | null
    addedAt: number
  }[]
}

/**
 * A public blogroll by id, or null, alike, for an id of the wrong shape, one nobody made, a
 * deleted blogroll, a private one, and one whose owner is out of good standing: a private
 * blogroll's id is refused to anyone who guesses it and to anyone it was shared with alike, and
 * the answer never says which. The operator's Hide from Discover does not touch the page.
 *
 * The blogs are the ones others see (`visibleBlogsFrom`: not taken out, not of a blog the operator
 * hid), each with its reader count from three readers up and its description cut to a tagline.
 */
export async function readBlogroll(
  deps: Pick<ApiDeps, 'db' | 'clock'>,
  id: string,
): Promise<BlogrollPage | null> {
  const { db } = deps
  if (!BLOGROLL_ID.test(id)) return null
  const [heads, blogs] = (await db.batch([
    // Its owner by their profile: a member with no profile has no public name to show it under.
    db.all(sql`
      select r.id, r.name, r.description, ${BLOGROLL_UPDATED_AT} as "updatedAt",
        ${blogrollIndexable(deps.clock.now())} as indexable, p.user_id as "ownerId", p.handle, p.display_name as "displayName",
        ${avatarOf('p')} as avatar
      from blogrolls r join profiles p on p.user_id = r.user_id
      where r.id = ${id} and ${isShown('r')} and ${standingOk('p')}
    `),
    // A merged feed's row stays (ADR 0028): it is not updating when the feed it became is not.
    db.all(sql`
      select bb.feed_id as "feedId", s.id as "siteId", ${BLOG_NAME} as name,
        s.home_url as "homeUrl", s.favicon_key as "faviconKey", s.primary_lang as "primaryLang",
        substr(s.description, 1, ${sql.raw(String(BLOG_DESCRIPTION_MAX))}) as description,
        (s.listing in ${PUBLIC_LISTING}) as listed, ${READER_COUNT} as "readerCount",
        (coalesce((select t.status from feeds t where t.id = f.merged_into), f.status) = 'dead')
          as dead,
        bb.note, bb.added_at as "addedAt"
      from blogrolls r, ${visibleBlogsFrom('r')}
        and r.id = ${id} and ${isShown('r')}
      order by bb.added_at, bb.feed_id
    `),
  ] as never)) as unknown as Row[][]
  const head = heads?.[0]
  if (!head) return null
  return {
    blogroll: {
      id: String(head.id),
      name: String(head.name),
      description: String(head.description ?? ''),
      updatedAt: Number(head.updatedAt),
      // Whether search engines may index it (ADR 0060).
      indexable: head.indexable === 1,
    },
    owner: {
      id: String(head.ownerId),
      handle: String(head.handle),
      displayName: (head.displayName as string | null) ?? null,
      avatar: (head.avatar as string | null) ?? null,
    },
    blogs: (blogs ?? []).map((b) => ({
      feedId: Number(b.feedId),
      siteId: Number(b.siteId),
      name: (b.name as string | null) ?? null,
      homeUrl: String(b.homeUrl),
      faviconKey: (b.faviconKey as string | null) ?? null,
      primaryLang: (b.primaryLang as string | null) ?? null,
      description: (b.description as string | null) || null,
      listed: b.listed === 1,
      readerCount: b.readerCount == null ? null : Number(b.readerCount),
      dead: b.dead === 1,
      note: (b.note as string | null) ?? null,
      addedAt: Number(b.addedAt),
    })),
  }
}

/** A search query as SQL LIKE sees it: trimmed, whitespace collapsed, wildcards escaped. */
export function likePattern(query: string): string | null {
  const q = query.trim().replace(/\s+/g, ' ').slice(0, 100)
  if (!q) return null
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
}

/** What a search found: blogs, and a page of posts from the member's own feeds. */
export type SearchPage = {
  sites: Row[]
  /**
   * Each with the title the member reads it under, when it has one, as `translatedTitle`, and its
   * blog's id as `siteId`.
   */
  articles: Row[]
  /** Whether a later page has more posts. */
  more: boolean
}

/**
 * Search past what the device holds: posts of the actor's feeds by title in either language, and
 * blogs anyone can find plus the actor's own private ones (`SEARCH_SITES` of them, ranked, on
 * every page). A hit may match its translation, so it comes with the title the member reads it
 * under in `lang` (AGENTS.md: showing the original would render a hit with none of the words
 * typed), never one of a blog whose writer turned translation off.
 */
export async function search(
  deps: Pick<ApiDeps, 'db'>,
  actor: Pick<Actor, 'userId'>,
  input: { q: string; lang?: string | undefined; page?: number | undefined },
): Promise<SearchPage> {
  const { db } = deps
  const pattern = likePattern(input.q)
  if (!pattern) return { sites: [], articles: [], more: false }
  const lang = isReadingLanguage(input.lang) ? input.lang : null
  const page = pageOf(input.page)
  const [sites, articles] = (await db.batch([
    db.all(sql`
      select s.id, s.title, s.home_url as "homeUrl", s.description, s.favicon_key as "faviconKey",
        ${publicReaderCount('s')} as "readerCount",
        (select min(id) from feeds where site_id = s.id and merged_into is null) as "feedId"
      from sites s
      where (s.listing in ('listed', 'featured') or s.id in (
          select f.site_id from subscriptions sub join feeds f on f.id = sub.feed_id
          where sub.user_id = ${actor.userId} and sub.deleted_at is null))
        and (s.title like ${pattern} escape '\\' or s.home_url like ${pattern} escape '\\'
          or s.description like ${pattern} escape '\\'
          or exists (select 1 from feeds f where f.site_id = s.id and f.title like ${pattern} escape '\\'))
      limit 50
    `),
    db.all(sql`
      select ${ARTICLE_COLUMNS}, (select site_id from feeds where id = a.feed_id) as "siteId",
        (select t.title from article_titles t join feeds tf on tf.id = a.feed_id
          join sites ts on ts.id = tf.site_id
          where t.article_id = a.id and t.lang = ${lang} and ts.translation_opt_out = 0)
          as "translatedTitle"
      from articles a
      where a.feed_id in (select feed_id from subscriptions where user_id = ${actor.userId} and deleted_at is null)
        and (a.title like ${pattern} escape '\\' or exists (
          select 1 from article_titles t where t.article_id = a.id and t.title like ${pattern} escape '\\'))
      order by a.sort_at desc, a.id desc
      limit ${SEARCH_POSTS_PAGE + 1} offset ${(page - 1) * SEARCH_POSTS_PAGE}
    `),
  ] as never)) as unknown as [Row[], Row[]]
  const q = input.q.trim().toLowerCase()
  // Ranked in the app, replacing pg_trgm: a prefix beats a substring, a title beats a host.
  // A count kept back (below three readers) ranks as none, so the order tells no more than it.
  const score = (s: Row) => {
    const title = String(s.title ?? '').toLowerCase()
    const host = String(s.homeUrl ?? '')
      .replace(/^https?:\/\//, '')
      .toLowerCase()
    if (title.startsWith(q)) return 0
    if (title.includes(q)) return 1
    if (host.startsWith(q)) return 2
    if (host.includes(q)) return 3
    return 4
  }
  sites.sort((a, b) => score(a) - score(b) || Number(b.readerCount) - Number(a.readerCount))
  return {
    sites: sites.slice(0, SEARCH_SITES),
    articles: articles.slice(0, SEARCH_POSTS_PAGE),
    more: articles.length > SEARCH_POSTS_PAGE,
  }
}

/**
 * Blogs by id as a card shows one anywhere: name, address, description, favicon, language, reader
 * count as anyone may see it, and topics. For answers that name blogs a page already chose
 * (a profile's subscriptions, a search's blogs, a blogroll's), which carry less of each; what may
 * be shown was decided there, so this decides nothing. One statement, the ids as one JSON
 * parameter.
 */
export async function readBlogCards(
  deps: Pick<ApiDeps, 'db'>,
  siteIds: readonly number[],
): Promise<Map<number, Row>> {
  if (siteIds.length === 0) return new Map()
  const rows = await deps.db.all<Row>(sql`
    select s.id, s.title, s.home_url as "homeUrl", s.description, s.favicon_key as "faviconKey",
      s.primary_lang as "primaryLang", ${READER_COUNT} as "readerCount",
      (select json_group_array(x.topic) from (
        select t.topic from site_topics t where t.site_id = s.id order by t.topic) x) as topics
    from sites s where s.id in (select value from json_each(${JSON.stringify([...new Set(siteIds)])}))
  `)
  return new Map(
    rows.map((r) => {
      const topics = parseJson(r.topics)
      return [
        Number(r.id),
        { ...r, topics: Array.isArray(topics) ? topics.filter((t) => typeof t === 'string') : [] },
      ]
    }),
  )
}

/** A post as a member's device holds one, with its feed and blog, in the sync's row shapes. */
export type HeldArticle = { article: ArticleRow; feed: FeedRow; site: SiteRow }

/**
 * A post by id, for `actor` to hold and open as if their device had synced it (ADR 0066): the
 * article row with its content key, its feed and its blog, or null when Tela holds no such post.
 * Any member may open any post Tela holds, the web's rule, which apps follow: what bounds it is
 * the day's limit on bodies from blogs the member does not follow, counted when the body is
 * fetched, not here. Whoever calls this has checked the actor's standing (tela-api's member
 * check for the web, the token's resolution for an app).
 */
export async function readArticle(
  deps: Pick<ApiDeps, 'db'>,
  actor: Pick<Actor, 'userId'>,
  articleId: number,
): Promise<HeldArticle | null> {
  const { db } = deps
  if (!Number.isSafeInteger(articleId) || articleId <= 0) return null
  const feedOf = sql`(select feed_id from articles where id = ${articleId})`
  const [articles, feeds, sites] = (await db.batch([
    db.all(sql`select ${ARTICLE_COLUMNS} from articles a where a.id = ${articleId}`),
    db.all(sql`select ${FEED_COLUMNS} from feeds f where f.id = ${feedOf}`),
    db.all(sql`select ${siteColumns(actor.userId)} from sites s
      where s.id = (select site_id from feeds where id = ${feedOf})`),
  ] as never)) as unknown as [ArticleRow[], FeedRow[], Row[]]
  const article = articles[0]
  const feed = feeds[0]
  const site = sites[0]
  if (!article || !feed || !site) return null
  return {
    article,
    feed,
    site: {
      ...(site as unknown as SiteRow),
      owned: site.owned === 1,
      claimed: site.claimed === 1,
      translationOptOut: site.translationOptOut === 1,
    },
  }
}

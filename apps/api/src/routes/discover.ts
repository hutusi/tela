/**
 * Discover's tabs past Blogs (ADR 0044): This week, Articles and Readers. Each answer is the same
 * for everyone, so the edge renders it for visitors and caches it; what is personal (hiding the
 * blogs a member reads, naming the people they follow, grouping suggested readers by what they
 * like) is worked out on the device, from its own rows. Nothing about the viewer reaches here.
 *
 * As everywhere public: listed and featured blogs only, a merged feed's posts never (they are
 * copies of its target's, ADR 0028), future-dated posts not before their date, and nothing that
 * says how a blog was listed (ADR 0041). Each is cached as a profile is, minutes and never a day:
 * the readers carry public subscriptions, which a member can stop showing (ADR 0031), and a
 * week's counts go stale.
 *
 * Mounted at `/api/v1/public/discover`, beside the Blogs answer at that path itself (`public.ts`).
 */
import { ARTICLE_COLUMNS, avatarOf, type TelaDb } from '@tela/data'
import { isTopic } from '@tela/shared'
import { type SQL, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import type { ApiEnv } from '../app'
import type { ApiDeps } from '../deps'
import {
  DAY,
  EXCERPTS,
  editionStatement,
  LANG,
  POST_SITE,
  type PostSite,
  PROFILE_CACHE,
  PUBLIC_LISTING,
  postExtras,
  postOf,
  RECOMMENDERS_SHOWN,
  siteCard,
  TITLES,
} from './public-sql'

export { RECOMMENDERS_SHOWN }

/** Posts on one page of Articles. */
export const ARTICLES_PAGE = 30
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

type Row = Record<string, unknown>

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
  select ${ARTICLE_COLUMNS}, ${TITLES}, ${EXCERPTS}, ${POST_SITE}, ${postExtras(since)}
  from (select article_id, count(*) as n from recommendations
        where deleted_at is null and created_at >= ${since} and created_at <= ${now}
        group by article_id) w
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
      where exists (select 1 from recommendations r
          where r.user_id = p.user_id and r.deleted_at is null)
        or (p.public_subscriptions = 1 and exists (
          select 1 from subscriptions sub join feeds f on f.id = sub.feed_id
          join sites s on s.id = f.site_id
          where sub.user_id = p.user_id and sub.deleted_at is null
            and s.listing in ${PUBLIC_LISTING}))
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
      select ranked.user_id as "userId", ranked.later as others, ${ARTICLE_COLUMNS}, ${TITLES},
        ${POST_SITE}
      from ranked join articles a on a.id = ranked.article_id
      join feeds f on f.id = a.feed_id join sites s on s.id = f.site_id
      where ranked.k = 1
    `),
    db.all(sql`
      select x.user_id as "userId", x.note, ${ARTICLE_COLUMNS}, ${TITLES}, ${POST_SITE}
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

export function discoverRoutes(deps: ApiDeps) {
  const { db } = deps
  const routes = new Hono<ApiEnv>()
  const cached = { 'cache-control': PROFILE_CACHE }

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
  routes.get('/week', async (c) => {
    const now = deps.clock.now()
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
    return c.json(
      {
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
      },
      200,
      cached,
    )
  })

  /**
   * Articles: every public post, newest first, a page at a time behind a `sortAt:id` cursor,
   * cut by key and never by offset, so a post written meanwhile repeats or skips nothing; on the
   * first page only, the week's most recommended, whole, since their counts move between pages;
   * and the languages posts were written in over 90 days. A topic narrows all three, a language
   * all but the languages.
   */
  routes.get('/articles', async (c) => {
    const now = deps.clock.now()
    const since = now - 7 * DAY
    const topic = c.req.query('topic')
    const lang = c.req.query('lang')
    const byTopic = isTopic(topic)
      ? sql`and exists (select 1 from site_topics t where t.site_id = s.id and t.topic = ${topic})`
      : sql``
    const byLang = lang && LANG.test(lang) ? sql`and a.source_lang = ${lang}` : sql``
    const cursor = CURSOR.exec(c.req.query('cursor') ?? '')
    const after = cursor
      ? sql`and (a.sort_at, a.id) < (${Number(cursor[1])}, ${Number(cursor[2])})`
      : sql``
    const [posts, recommended, languages] = (await db.batch([
      db.all(sql`
        select ${ARTICLE_COLUMNS}, ${TITLES}, ${EXCERPTS}, ${POST_SITE}, ${postExtras(since)}
        from articles a
        join feeds f on f.id = a.feed_id and f.merged_into is null
        join sites s on s.id = f.site_id
        where s.listing in ${PUBLIC_LISTING} and a.sort_at <= ${now} ${byTopic} ${byLang} ${after}
        order by a.sort_at desc, a.id desc
        limit ${ARTICLES_PAGE + 1}
      `),
      cursor
        ? db.all(sql`select 1 where false`)
        : db.all(recommendedStatement(now, since, sql`${byTopic} ${byLang}`, WEEK_POSTS)),
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
    const page = (posts ?? []).slice(0, ARTICLES_PAGE)
    const last = page.at(-1)
    return c.json(
      {
        recommended: cursor ? [] : (recommended ?? []).map(discoverPost),
        posts: page.map(discoverPost),
        next: (posts ?? []).length > ARTICLES_PAGE && last ? `${last.sortAt}:${last.id}` : null,
        languages: (languages ?? []).map((l) => ({ lang: String(l.lang), count: Number(l.count) })),
      },
      200,
      cached,
    )
  })

  /** Readers: the people Discover may suggest, for the device to match to what its member likes. */
  routes.get('/readers', async (c) =>
    c.json(
      {
        readers: await readersPool(db, deps.clock.now(), {
          people: READERS_POOL,
          recs: RECS_PER_READER,
        }),
      },
      200,
      cached,
    ),
  )

  return routes
}

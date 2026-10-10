/**
 * What anyone may see, signed in or not: the front page's edition, Discover, a blog's page, a
 * member's public profile, and whether a handle is free. JSON here; tela-web renders it into
 * server-side pages and caches them at the edge (ADR 0024; the pages come with the SPA's
 * components in Phase 6).
 *
 * Only listed and featured blogs appear. The Postgres app rendered a private or rejected site's
 * page for anyone with its id, which on a cached public page would be a leak. A reader count is
 * given from three readers up and is null below, in the order as well as the value, and no answer
 * says how a blog was listed: nothing public renders it, and beside a held-back count it would
 * tell a blog an operator listed from the queue from an editorial pick (ADR 0041).
 */
import { ARTICLE_COLUMNS, avatarOf, consumeLimit, first } from '@tela/data'
import { HANDLE, isTopic, RESERVED_HANDLES } from '@tela/shared'
import { getIP } from 'better-auth/api'
import { sql } from 'drizzle-orm'
import { Hono } from 'hono'
import type { ApiEnv } from '../app'
import type { Auth } from '../auth'
import type { ApiDeps } from '../deps'
import {
  DAY,
  editionStatement,
  LANG,
  PROFILE_CACHE,
  PUBLIC_CACHE,
  PUBLIC_LISTING,
  parseLangMap,
  READER_COUNT,
  siteCard,
  TITLES,
  withTitles,
} from './public-sql'

export { PROFILE_CACHE, PUBLIC_CACHE }

/** The front page's edition: the week's newest post from each blog, at most this many. */
export const EDITION_POSTS = 11
/**
 * Blogs on one page of Discover. The directory outgrew one page when the editorial list reached
 * 110, and a bare `limit` dropped the newest blogs from All with nothing to say so.
 */
export const DISCOVER_PAGE = 60
/** better-auth's bucket for a request whose IP it cannot tell, which all such requests share. */
const NO_IP = 'no-trusted-ip'
/** Suffixes tried, in order, for a free handle near one that is taken or reserved. */
const HANDLE_SUFFIXES = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '_writes']

export function publicRoutes(deps: ApiDeps, auth: Auth) {
  const { db } = deps
  const routes = new Hono<ApiEnv>()
  const cached = { 'cache-control': PUBLIC_CACHE }
  const notFound = () =>
    new Response(JSON.stringify({ error: 'not_found' }), {
      status: 404,
      headers: {
        'content-type': 'application/json',
        'cache-control': 'public, max-age=60, s-maxage=60',
      },
    })

  /**
   * Which providers the sign-in sheet may offer (ADR 0036): each only once its app is configured.
   * A browser may keep the answer five minutes, so a provider switched on shows within that.
   */
  routes.get('/auth', (c) =>
    c.json(
      { google: Boolean(deps.config.oauth?.google), github: Boolean(deps.config.oauth?.github) },
      200,
      { 'cache-control': 'public, max-age=300' },
    ),
  )

  routes.get('/discover', async (c) => {
    const topic = c.req.query('topic')
    const lang = c.req.query('lang')
    const byTopic = isTopic(topic)
      ? sql`and exists (select 1 from site_topics t where t.site_id = s.id and t.topic = ${topic})`
      : sql``
    const byLang = lang && LANG.test(lang) ? sql`and s.primary_lang = ${lang}` : sql``
    const asked = Number(c.req.query('page'))
    const page = Number.isInteger(asked) && asked > 1 && asked <= 1000 ? asked : 1
    const now = deps.clock.now()
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
      Record<string, unknown>[],
      { lang: string; count: number }[],
      { siteId: number; topic: string }[],
      { total: number }[],
    ]
    return c.json(
      {
        sites: sites.map((s) => ({
          ...s,
          claimed: s.claimed === 1,
          topics: topics.filter((t) => t.siteId === s.id).map((t) => t.topic),
        })),
        languages,
        total: Number(totals[0]?.total ?? 0),
        page,
        pageSize: DISCOVER_PAGE,
      },
      200,
      cached,
    )
  })

  routes.get('/sites/:siteId', async (c) => {
    const siteId = Number(c.req.param('siteId'))
    if (!Number.isInteger(siteId)) return notFound()
    const since = deps.clock.now() - 30 * DAY
    const [sites, feeds, posts, topics, notes] = (await db.batch([
      db.all(sql`
        select s.id, s.title, s.home_url as "homeUrl", s.description, s.favicon_key as "faviconKey",
          s.primary_lang as "primaryLang", ${READER_COUNT} as "readerCount",
          p.handle as "claimedBy", p.display_name as "claimantName", p.bio as "claimantBio",
          ${avatarOf('p')} as "claimantAvatar",
          (select count(*) from articles a join feeds f on f.id = a.feed_id
            where f.site_id = s.id and f.merged_into is null and a.sort_at >= ${since})
            as "postsLast30d"
        from sites s left join profiles p on p.user_id = s.claimed_by
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
        select ${ARTICLE_COLUMNS}, ${TITLES}
        from articles a join feeds f on f.id = a.feed_id join sites s on s.id = f.site_id
        where f.site_id = ${siteId} and f.merged_into is null and s.listing in ${PUBLIC_LISTING}
        order by a.sort_at desc, a.id desc limit 20
      `),
      db.all(sql`select topic from site_topics where site_id = ${siteId}`),
      // What readers said recommending its posts: recommendations are public (ADR 0031).
      db.all(sql`
        select r.note, r.created_at as "createdAt", p.handle, p.display_name as "displayName",
          ${ARTICLE_COLUMNS}, ${TITLES}
        from recommendations r join articles a on a.id = r.article_id
        join feeds f on f.id = a.feed_id join sites s on s.id = f.site_id
        join profiles p on p.user_id = r.user_id
        where f.site_id = ${siteId} and s.listing in ${PUBLIC_LISTING}
          and r.deleted_at is null and r.note is not null and r.note <> ''
        order by r.created_at desc limit 5
      `),
    ] as never)) as unknown as Record<string, unknown>[][]
    const row = sites?.[0]
    if (!row) return notFound()
    const { claimantName, claimantBio, claimantAvatar, ...site } = row
    return c.json(
      {
        site: {
          ...site,
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
        feeds,
        posts: (posts ?? []).map(withTitles),
        topics: (topics ?? []).map((t) => t.topic),
        notes: (notes ?? []).map((n) => {
          const { note, createdAt, handle, displayName, ...article } = n
          return { note, createdAt, person: { handle, displayName }, article: withTitles(article) }
        }),
      },
      200,
      cached,
    )
  })

  routes.get('/profiles/:handle', async (c) => {
    const handle = c.req.param('handle').toLowerCase()
    const profile = await first<{
      user_id: string
      handle: string
      display_name: string | null
      bio: string | null
      created_at: number
      public_subscriptions: number
      public_likes: number
      avatar: string | null
    }>(
      db,
      sql`select user_id, handle, display_name, bio, created_at, public_subscriptions, public_likes,
            ${avatarOf('p')} as avatar
          from profiles p where handle = ${handle}`,
    )
    if (!profile) return notFound()
    const id = profile.user_id
    const none = sql`select 1 where false`
    const [blogs, recommendations, subscriptions, liked, counts] = (await db.batch([
      db.all(sql`
        select id, title, home_url as "homeUrl", favicon_key as "faviconKey" from sites
        where claimed_by = ${id} and listing in ${PUBLIC_LISTING} order by title
      `),
      db.all(sql`
        select r.note, r.created_at as "createdAt", s.id as "siteId", s.title as "siteTitle",
          s.home_url as "homeUrl", (s.listing in ${PUBLIC_LISTING}) as listed, ${ARTICLE_COLUMNS},
          ${TITLES}
        from recommendations r join articles a on a.id = r.article_id
        join feeds f on f.id = a.feed_id join sites s on s.id = f.site_id
        where r.user_id = ${id} and r.deleted_at is null
        order by r.created_at desc limit 100
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
              s.home_url as "homeUrl", (s.listing in ${PUBLIC_LISTING}) as listed, ${ARTICLE_COLUMNS},
              ${TITLES}
            from user_article_states st join articles a on a.id = st.article_id
            join feeds f on f.id = a.feed_id join sites s on s.id = f.site_id
            where st.user_id = ${id} and st.liked_at is not null
            order by st.liked_at desc limit 100
          `)
        : db.all(none),
      db.all(sql`
        select
          (select count(*) from follows where follower_id = ${id} and deleted_at is null) as following,
          (select count(*) from follows where followee_id = ${id} and deleted_at is null) as followers,
          (select count(*) from recommendations where user_id = ${id} and deleted_at is null)
            as recommendations,
          (select count(*) from user_article_states where user_id = ${id} and liked_at is not null)
            as liked
      `),
    ] as never)) as unknown as Record<string, unknown>[][]
    const count = counts?.[0] ?? {}
    const shownSubscriptions = profile.public_subscriptions
      ? (subscriptions ?? []).map((s) => ({ ...s, listed: s.listed === 1 }))
      : null
    // The post as the reader holds one, beside the note (or when it was liked) and its blog.
    const withArticle = (r: Record<string, unknown>) => {
      const { note, createdAt, likedAt, siteId, siteTitle, homeUrl, listed, ...article } = r
      return {
        ...(likedAt === undefined ? { note, createdAt } : { likedAt }),
        siteId,
        siteTitle,
        homeUrl,
        listed: listed === 1,
        article: withTitles(article),
      }
    }
    return c.json(
      {
        profile: {
          // The account id: what a follow names (ADR 0031). It grants nothing on its own.
          id,
          handle: profile.handle,
          displayName: profile.display_name,
          bio: profile.bio,
          avatar: profile.avatar,
          memberSince: profile.created_at,
        },
        counts: {
          following: Number(count.following ?? 0),
          followers: Number(count.followers ?? 0),
          recommendations: Number(count.recommendations ?? 0),
          liked: profile.public_likes ? Number(count.liked ?? 0) : null,
          subscriptions: shownSubscriptions ? shownSubscriptions.length : null,
        },
        blogs,
        recommendations: (recommendations ?? []).map(withArticle),
        // The member chose to show what they read; a private blog shows no link to its page.
        subscriptions: shownSubscriptions,
        liked: profile.public_likes ? (liked ?? []).map(withArticle) : null,
      },
      200,
      { 'cache-control': PROFILE_CACHE },
    )
  })

  /**
   * The front page's edition (ADR 0035): the newest post of each public blog, newest first, from
   * the last seven days, or the latest ones when nobody wrote that week (`editionStatement`); and
   * the counts its copy states. Cached as a profile is, so the counts a visitor reads are minutes
   * old at most.
   */
  routes.get('/front', async (c) => {
    const now = deps.clock.now()
    const since = now - 7 * DAY
    const [rows, counts] = (await db.batch([
      db.all(editionStatement(now)),
      db.all(sql`
        select (select count(*) from sites where listing in ${PUBLIC_LISTING}) as blogs,
          count(distinct f.site_id) as "weekBlogs",
          count(distinct a.source_lang) as "weekLanguages",
          count(a.id) as "weekPosts"
        from sites s join feeds f on f.site_id = s.id and f.merged_into is null
        join articles a on a.feed_id = f.id and a.sort_at >= ${since} and a.sort_at <= ${now}
        where s.listing in ${PUBLIC_LISTING}
      `),
    ] as never)) as unknown as [Record<string, unknown>[], Record<string, unknown>[]]
    const week = rows.filter((r) => Number(r.sortAt) >= since)
    const span = week.length > 0 ? 'week' : 'latest'
    const count = counts[0] ?? {}
    return c.json(
      {
        counts: { blogs: Number(count.blogs ?? 0) },
        week: {
          blogs: Number(count.weekBlogs ?? 0),
          languages: Number(count.weekLanguages ?? 0),
          posts: Number(count.weekPosts ?? 0),
        },
        edition: {
          span,
          posts: (span === 'week' ? week : rows).slice(0, EDITION_POSTS).map((r) => {
            const {
              siteId,
              siteTitle,
              homeUrl,
              faviconKey,
              primaryLang,
              claimantHandle,
              claimantName,
              excerpts,
              ...article
            } = r
            return {
              article: { ...withTitles(article), excerpts: parseLangMap(excerpts) },
              site: { id: siteId, title: siteTitle, homeUrl, faviconKey, primaryLang },
              claimant: claimantHandle
                ? { handle: claimantHandle, displayName: claimantName }
                : null,
            }
          }),
        },
      },
      200,
      { 'cache-control': PROFILE_CACHE },
    )
  })

  /**
   * Whether a handle is free, for For writers' card as it is typed: `invalid` (the shape
   * `HANDLE` refuses), `reserved` (an app path), `taken`, or `available`; and, unless it is
   * invalid, the first free handle among it and a few made from it. Never cached: the answer
   * changes the moment someone takes one. Counted per IP. The profile save it comes before checks
   * the same rules again, in the statement that takes the handle.
   */
  routes.get('/handles/:handle', async (c) => {
    const handle = c.req.param('handle').trim().toLowerCase()
    const noStore = { 'cache-control': 'no-store' }
    // A shape the rules refuse costs no query, so it spends none of the IP's checks.
    if (!HANDLE.test(handle)) {
      return c.json({ handle, status: 'invalid', suggestion: null }, 200, noStore)
    }
    const ip = getIP(c.req.raw, auth.options) ?? NO_IP
    const limited = await consumeLimit(db, 'handleCheck', ip, deps.clock.now())
    if (!limited.allowed) {
      return c.json({ error: 'rate_limited' }, 429, {
        ...noStore,
        'retry-after': String(limited.retryAfterSec),
      })
    }
    const reserved = RESERVED_HANDLES.has(handle)
    // Free ones only, in order: the handle itself first, so the first free one says whether it is.
    const candidates = [
      ...(reserved ? [] : [handle]),
      ...HANDLE_SUFFIXES.map((suffix) => `${handle}${suffix}`).filter(
        (h) => HANDLE.test(h) && !RESERVED_HANDLES.has(h),
      ),
    ]
    const free = await first<{ value: string }>(
      db,
      sql`select j.value from json_each(${JSON.stringify(candidates)}) j
        where not exists (select 1 from profiles p where p.handle = j.value)
        order by j.key limit 1`,
    )
    const suggestion = free?.value ?? null
    const status = reserved ? 'reserved' : suggestion === handle ? 'available' : 'taken'
    return c.json({ handle, status, suggestion }, 200, noStore)
  })

  return routes
}

/**
 * What anyone may see, signed in or not: Discover, a blog's page, a member's public profile. JSON
 * here; tela-web renders it into server-side pages and caches them at the edge (ADR 0024; the
 * pages come with the SPA's components in Phase 6).
 *
 * Only listed and featured blogs appear. The Postgres app rendered a private or rejected site's
 * page for anyone with its id, which on a cached public page would be a leak.
 */
import { first } from '@tela/data'
import { isTopic } from '@tela/shared'
import { sql } from 'drizzle-orm'
import { Hono } from 'hono'
import type { ApiEnv } from '../app'
import type { ApiDeps } from '../deps'

/** Five minutes at the edge, a day of serving stale while it refreshes. */
export const PUBLIC_CACHE = 'public, max-age=60, s-maxage=300, stale-while-revalidate=86400'
const LANG = /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/
const DAY = 24 * 60 * 60 * 1000
const PUBLIC_LISTING = sql.raw(`('listed', 'featured')`)

export function publicRoutes(deps: ApiDeps) {
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

  routes.get('/discover', async (c) => {
    const topic = c.req.query('topic')
    const lang = c.req.query('lang')
    const byTopic = isTopic(topic)
      ? sql`and exists (select 1 from site_topics t where t.site_id = s.id and t.topic = ${topic})`
      : sql``
    const byLang = lang && LANG.test(lang) ? sql`and s.primary_lang = ${lang}` : sql``
    const since = deps.clock.now() - 30 * DAY
    const [sites, languages, topics] = (await db.batch([
      db.all(sql`
        select s.id, s.title, s.home_url as "homeUrl", s.description, s.favicon_key as "faviconKey",
          s.primary_lang as "primaryLang", s.listing, (s.claimed_by is not null) as claimed,
          s.reader_count as "readerCount",
          (select min(f.id) from feeds f where f.site_id = s.id) as "feedId",
          (select a.title from articles a join feeds f on f.id = a.feed_id where f.site_id = s.id
            order by a.sort_at desc limit 1) as "latestTitle",
          (select max(a.sort_at) from articles a join feeds f on f.id = a.feed_id where f.site_id = s.id)
            as "latestAt",
          (select count(*) from articles a join feeds f on f.id = a.feed_id
            where f.site_id = s.id and a.sort_at >= ${since}) as "postsLast30d"
        from sites s
        where s.listing in ${PUBLIC_LISTING} ${byTopic} ${byLang}
        order by s.listing = 'featured' desc, s.claimed_by is not null desc, s.reader_count desc, s.id
        limit 60
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
    ] as never)) as unknown as [
      Record<string, unknown>[],
      { lang: string; count: number }[],
      { siteId: number; topic: string }[],
    ]
    return c.json(
      {
        sites: sites.map((s) => ({
          ...s,
          claimed: s.claimed === 1,
          topics: topics.filter((t) => t.siteId === s.id).map((t) => t.topic),
        })),
        languages,
      },
      200,
      cached,
    )
  })

  routes.get('/sites/:siteId', async (c) => {
    const siteId = Number(c.req.param('siteId'))
    if (!Number.isInteger(siteId)) return notFound()
    const [sites, feeds, posts, topics] = (await db.batch([
      db.all(sql`
        select s.id, s.title, s.home_url as "homeUrl", s.description, s.favicon_key as "faviconKey",
          s.primary_lang as "primaryLang", s.listing, s.reader_count as "readerCount",
          p.handle as "claimedBy"
        from sites s left join profiles p on p.user_id = s.claimed_by
        where s.id = ${siteId} and s.listing in ${PUBLIC_LISTING}
      `),
      db.all(sql`
        select f.id, f.feed_url as "feedUrl", f.title from feeds f
        join sites s on s.id = f.site_id
        where f.site_id = ${siteId} and s.listing in ${PUBLIC_LISTING} order by f.id
      `),
      db.all(sql`
        select a.id, a.title, a.url, a.published_at as "publishedAt", a.excerpt,
          a.source_lang as "sourceLang"
        from articles a join feeds f on f.id = a.feed_id join sites s on s.id = f.site_id
        where f.site_id = ${siteId} and s.listing in ${PUBLIC_LISTING}
        order by a.sort_at desc, a.id desc limit 20
      `),
      db.all(sql`select topic from site_topics where site_id = ${siteId}`),
    ] as never)) as unknown as Record<string, unknown>[][]
    const site = sites?.[0]
    if (!site) return notFound()
    return c.json({ site, feeds, posts, topics: (topics ?? []).map((t) => t.topic) }, 200, cached)
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
    }>(
      db,
      sql`select user_id, handle, display_name, bio, created_at, public_subscriptions
          from profiles where handle = ${handle}`,
    )
    if (!profile) return notFound()
    const [blogs, recommendations, subscriptions] = (await db.batch([
      db.all(sql`
        select id, title, home_url as "homeUrl", favicon_key as "faviconKey" from sites
        where claimed_by = ${profile.user_id} and listing in ${PUBLIC_LISTING} order by title
      `),
      db.all(sql`
        select r.note, r.created_at as "createdAt", a.id as "articleId", a.title, a.url,
          s.title as "siteTitle", s.home_url as "homeUrl"
        from recommendations r join articles a on a.id = r.article_id
        join feeds f on f.id = a.feed_id join sites s on s.id = f.site_id
        where r.user_id = ${profile.user_id} and r.deleted_at is null
        order by r.created_at desc limit 100
      `),
      profile.public_subscriptions
        ? db.all(sql`
            select distinct s.id, s.title, s.home_url as "homeUrl",
              (s.listing in ${PUBLIC_LISTING}) as listed
            from subscriptions sub join feeds f on f.id = sub.feed_id join sites s on s.id = f.site_id
            where sub.user_id = ${profile.user_id} and sub.deleted_at is null order by s.title
          `)
        : db.all(sql`select 1 where false`),
    ] as never)) as unknown as Record<string, unknown>[][]
    return c.json(
      {
        profile: {
          handle: profile.handle,
          displayName: profile.display_name,
          bio: profile.bio,
          memberSince: profile.created_at,
        },
        blogs,
        recommendations,
        // The member chose to show what they read; a private blog shows no link to its page.
        subscriptions: profile.public_subscriptions
          ? (subscriptions ?? []).map((s) => ({ ...s, listed: s.listed === 1 }))
          : null,
      },
      200,
      cached,
    )
  })

  return routes
}

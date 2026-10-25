/**
 * What Tela's own feeds are made of (ADR 0062): a public blogroll's blogs and their newest posts,
 * and Discover's blogs and newest posts, as JSON. tela-web renders them at `/l/<id>.opml`,
 * `/l/<id>.rss`, `/discover.opml` and `/discover/articles.rss`, through its copy per colo, so a
 * feed in four languages costs one D1 read: each post comes with its titles and excerpts in every
 * launch language it has, and the edge picks the one `?hl=` asks for.
 *
 * Narrower than the pages they come from, on purpose:
 * - Listed and featured blogs only. A blogroll's page shows every blog its owner put in but the
 *   rejected (ADR 0050), and names an unlisted one by its home page alone; its feed address is one
 *   a member typed, which Tela publishes nowhere and which may carry a private token. A listed
 *   blog's feed is on its page already.
 * - A blogroll the operator hid from Discover has no feeds, nor one of a member who is suspended
 *   or has left: a feed is read by aggregators and other sites, far beyond the page.
 * - A translation only where the blog allows translation (`translation_opt_out = 0`), and only
 *   of the title and excerpt as they are now: a stale one may translate a title since rewritten,
 *   and a feed reader keeps what it was first given.
 * - What a public page shows of a post and nothing more: its address, title, excerpt, blog and
 *   date. Never a body.
 *
 * Mounted at `/api/v1/public/feeds`.
 */
import { MAX_OPML_FEEDS } from '@tela/content/opml'
import { BLOG_NAME, isShown, standingOk, visibleBlogsFrom } from '@tela/data'
import { BLOGROLL_ID, isTopic } from '@tela/shared'
import { type SQL, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import type { ApiEnv } from '../app'
import type { ApiDeps } from '../deps'
import {
  BLOGROLL_UPDATED_AT,
  PROFILE_CACHE,
  PUBLIC_CACHE,
  PUBLIC_LISTING,
  parseLangMap,
  publicNotFound,
  READER_COUNT,
} from './public-sql'

/** Posts in a feed: about a month of a busy directory, and what readers expect of one. */
export const FEED_POSTS = 50
/**
 * Blogs in Discover's OPML: as many as Tela's own import reads from one document, so the file can
 * be brought back to Tela whole.
 */
export const DISCOVER_FEED_BLOGS = MAX_OPML_FEEDS

/** A blog as a feed of Tela's lists it: its name (null: the edge names it by its host). */
export type FeedBlog = { siteId: number; name: string | null; homeUrl: string; feedUrl: string }

/** A post as an RSS item of Tela's carries it. */
export type FeedPost = {
  id: number
  url: string
  title: string
  excerpt: string | null
  sourceLang: string | null
  sortAt: number
  /** By language: none for a blog that opted out of translation, and none that is stale. */
  titles: Record<string, string>
  excerpts: Record<string, string>
  blog: FeedBlog
}

type Row = Record<string, unknown>

/** A blogroll others can see, still: public, live, not hidden, its owner in good standing. */
const SHOWN_BLOGROLL = (id: string) => sql`r.id = ${id} and ${isShown('r')} and r.hidden_at is null`

/** Only an address a feed reader can follow: the post's link and its guid. */
const WEB_URL = sql.raw(`(a.url like 'https://%' or a.url like 'http://%')`)

/**
 * A post's columns, over `articles a`, its live feed `f` and its blog `s`. A translation counts
 * only while it is of the title and excerpt the post has now (`source_hash`), and only on a blog
 * that allows translation.
 */
const POST = sql.raw(`a.id, a.url, a.title, a.excerpt, a.source_lang as "sourceLang",
  a.sort_at as "sortAt",
  case when s.translation_opt_out = 0 then (select json_group_object(t.lang, t.title)
    from article_titles t where t.article_id = a.id and t.title is not null
      and t.source_hash = a.title_hash) end as titles,
  case when s.translation_opt_out = 0 then (select json_group_object(t.lang, t.excerpt)
    from article_titles t where t.article_id = a.id and t.excerpt is not null
      and t.source_hash = a.title_hash) end as excerpts,
  s.id as "siteId", coalesce(s.title, f.title) as "blogName", s.home_url as "homeUrl",
  f.feed_url as "feedUrl"`)

/** The newest public posts of the feeds `feeds` names (a subquery of feed ids), or of all. */
const postsStatement = (now: number, filter: SQL) => sql`
  select ${POST}
  from articles a
  join feeds f on f.id = a.feed_id and f.merged_into is null
  join sites s on s.id = f.site_id
  where s.listing in ${PUBLIC_LISTING} and a.sort_at <= ${now} and ${WEB_URL} ${filter}
  order by a.sort_at desc, a.id desc
  limit ${FEED_POSTS}
`

function postOf(r: Row): FeedPost {
  return {
    id: Number(r.id),
    url: String(r.url),
    title: String(r.title ?? ''),
    excerpt: (r.excerpt as string | null) || null,
    sourceLang: (r.sourceLang as string | null) ?? null,
    sortAt: Number(r.sortAt),
    titles: parseLangMap(r.titles),
    excerpts: parseLangMap(r.excerpts),
    blog: blogOf(r, 'blogName'),
  }
}

function blogOf(r: Row, name = 'name'): FeedBlog {
  return {
    siteId: Number(r.siteId),
    name: (r[name] as string | null) || null,
    homeUrl: String(r.homeUrl),
    feedUrl: String(r.feedUrl),
  }
}

/** Each feed once, where it is first listed: two rows may resolve to one feed through a merge. */
function onceEach(blogs: FeedBlog[]): FeedBlog[] {
  const seen = new Set<string>()
  return blogs.filter((b) => !seen.has(b.feedUrl) && seen.add(b.feedUrl))
}

export function publicFeedRoutes(deps: ApiDeps) {
  const { db } = deps
  const routes = new Hono<ApiEnv>()

  /**
   * A public blogroll's feeds: its listed blogs in its order, each by the feed a merge made it
   * (ADR 0028), and their newest posts. Cached as its page is, so a blogroll made private, hidden
   * or taken down leaves within minutes.
   */
  routes.get('/blogrolls/:id', async (c) => {
    const id = c.req.param('id')
    if (!BLOGROLL_ID.test(id)) return publicNotFound()
    const now = deps.clock.now()
    const [heads, blogs, posts] = (await db.batch([
      db.all(sql`
        select r.id, r.name, r.description, ${BLOGROLL_UPDATED_AT} as "updatedAt",
          p.handle, p.display_name as "displayName"
        from blogrolls r join profiles p on p.user_id = r.user_id
        where ${SHOWN_BLOGROLL(id)} and ${standingOk('p')}
      `),
      db.all(sql`
        select s.id as "siteId", ${BLOG_NAME} as name, s.home_url as "homeUrl",
          coalesce((select t.feed_url from feeds t where t.id = f.merged_into), f.feed_url)
            as "feedUrl"
        from blogrolls r, ${visibleBlogsFrom('r')}
          and ${SHOWN_BLOGROLL(id)} and s.listing in ${PUBLIC_LISTING}
        order by bb.added_at, bb.feed_id
      `),
      db.all(
        postsStatement(
          now,
          sql`and a.feed_id in (
            select coalesce(f.merged_into, f.id) from blogrolls r, ${visibleBlogsFrom('r')}
              and ${SHOWN_BLOGROLL(id)} and s.listing in ${PUBLIC_LISTING})`,
        ),
      ),
    ] as never)) as unknown as Row[][]
    const head = heads?.[0]
    if (!head) return publicNotFound()
    return c.json(
      {
        blogroll: {
          id: String(head.id),
          name: String(head.name),
          description: String(head.description ?? ''),
          updatedAt: Number(head.updatedAt),
        },
        owner: {
          handle: String(head.handle),
          displayName: (head.displayName as string | null) ?? null,
        },
        blogs: onceEach((blogs ?? []).map((b) => blogOf(b))),
        posts: (posts ?? []).map(postOf),
      },
      200,
      { 'cache-control': PROFILE_CACHE },
    )
  })

  /**
   * Discover's feeds: its blogs as the Blogs tab orders them, each by the feed its Subscribe adds,
   * and the Articles tab's stream, newest first; a topic narrows both.
   */
  routes.get('/discover', async (c) => {
    const asked = c.req.query('topic')
    const topic = isTopic(asked) ? asked : null
    const byTopic = topic
      ? sql`and exists (select 1 from site_topics t where t.site_id = s.id and t.topic = ${topic})`
      : sql``
    const now = deps.clock.now()
    const [blogs, posts] = (await db.batch([
      db.all(sql`
        select s.id as "siteId", coalesce(s.title, f.title) as name, s.home_url as "homeUrl",
          f.feed_url as "feedUrl"
        from sites s
        join feeds f on f.id = (
          select min(f2.id) from feeds f2 where f2.site_id = s.id and f2.merged_into is null)
        where s.listing in ${PUBLIC_LISTING} ${byTopic}
        order by s.listing = 'featured' desc, s.claimed_by is not null desc,
          coalesce(${READER_COUNT}, 0) desc, s.id
        limit ${DISCOVER_FEED_BLOGS}
      `),
      db.all(postsStatement(now, byTopic)),
    ] as never)) as unknown as Row[][]
    return c.json(
      {
        topic,
        blogs: onceEach((blogs ?? []).map((b) => blogOf(b))),
        posts: (posts ?? []).map(postOf),
      },
      200,
      { 'cache-control': PUBLIC_CACHE },
    )
  })

  return routes
}

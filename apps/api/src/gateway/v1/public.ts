/**
 * The public side in v1 (ADR 0065): Discover's tabs, a blog's page, a member's profile, a
 * blogroll, search, and a post opened by id. Each reads through the web's shared function
 * (`core/public.ts`), where what may be shown is decided (listing, standing, privacy switches, a
 * writer's "no translation"), and words it in the API's minimal cards. No card carries a content
 * key; `/v1/articles/{id}` is the one way to get one, and the body it opens is counted by the day's
 * limit on posts from blogs the member does not follow (ADR 0066).
 *
 * `?lang=` names the language of each post's `translatedTitle`. With it, a public answer is the
 * same for everyone and says so (`public, max-age=300`), and tela-gateway keeps it per colo;
 * without it, the member's own reading language is used and the answer is theirs alone. Search
 * and a post by id depend on the member, always.
 */

import { publicQuerySchema, searchQuerySchema } from '@tela/ext/schema'
import {
  v1Article,
  v1BlogCard,
  v1Feed,
  v1PostCard,
  v1ReaderCard,
  v1Site,
} from '@tela/ext/transform'
import type { ReadingLanguage } from '@tela/shared'
import type { Context } from 'hono'
import { Hono } from 'hono'
import {
  type DiscoverPost,
  readArticle,
  readBlogCards,
  readBlogroll,
  readDiscover,
  readProfile,
  readSitePage,
  search,
} from '../../core/public'
import type { ApiDeps } from '../../deps'
import type { GatewayEnv } from '../auth'
import { actorOf, memberLanguage, PRIVATE, PUBLIC, refuse, v1Context } from './answer'

type Row = Record<string, unknown>

export function publicRoutes(deps: ApiDeps) {
  const routes = new Hono<GatewayEnv>()
  const ctx = v1Context(deps.config)

  /**
   * The query a public route reads, the language its titles are in, and the cache its answer
   * allows; null for a query v1 does not take.
   */
  async function asked(c: Context<GatewayEnv>) {
    const query = publicQuerySchema.safeParse(c.req.query())
    if (!query.success) return null
    const named = query.data.lang
    const lang = named ?? (await memberLanguage(deps.db, c.get('app').userId))
    return {
      page: query.data.page ?? 1,
      topic: query.data.topic,
      lang,
      cache: named === undefined ? PRIVATE : PUBLIC,
    }
  }

  const post = (row: Row, siteId: unknown, lang: ReadingLanguage | null) =>
    v1PostCard(row, Number(siteId), lang)
  const discoverPost = (p: DiscoverPost, lang: ReadingLanguage | null) =>
    post(p.article, p.site.id, lang)

  routes.get('/discover/week', async (c) => {
    const q = await asked(c)
    if (!q) return refuse(c, 400, 'invalid_request')
    // The week's most recommended, then the newest posts of the front page's edition: one list,
    // each post once. The web lets the device choose between them; an app is given both, in order.
    const week = await readDiscover(deps, 'week')
    const seen = new Set<number>()
    const posts = [...week.recommended, ...week.edition.posts].filter((p) => {
      const id = Number(p.article.id)
      if (seen.has(id)) return false
      seen.add(id)
      return true
    })
    const first = q.page === 1
    return c.json(
      { posts: first ? posts.map((p) => discoverPost(p, q.lang)) : [], page: q.page, more: false },
      200,
      q.cache,
    )
  })

  routes.get('/discover/articles', async (c) => {
    const q = await asked(c)
    if (!q) return refuse(c, 400, 'invalid_request')
    const page = await readDiscover(deps, 'articles', { topic: q.topic, page: q.page })
    return c.json(
      {
        posts: page.posts.map((p) => discoverPost(p, q.lang)),
        page: q.page,
        more: page.next !== null,
      },
      200,
      q.cache,
    )
  })

  routes.get('/discover/blogs', async (c) => {
    const q = await asked(c)
    if (!q) return refuse(c, 400, 'invalid_request')
    const page = await readDiscover(deps, 'blogs', { topic: q.topic, page: q.page })
    return c.json(
      {
        blogs: page.sites.map((s) => v1BlogCard(s, ctx)),
        page: page.page,
        more: page.page * page.pageSize < page.total,
      },
      200,
      q.cache,
    )
  })

  routes.get('/discover/blogrolls', async (c) => {
    const q = await asked(c)
    if (!q) return refuse(c, 400, 'invalid_request')
    const page = await readDiscover(deps, 'blogrolls', { page: q.page })
    return c.json(
      {
        blogrolls: page.blogrolls.map((b) => ({
          id: b.id,
          name: b.name,
          description: b.description || null,
          owner: v1ReaderCard(b.owner, ctx),
          blogCount: b.blogCount,
        })),
        page: q.page,
        more: page.next !== null,
      },
      200,
      q.cache,
    )
  })

  routes.get('/discover/readers', async (c) => {
    const q = await asked(c)
    if (!q) return refuse(c, 400, 'invalid_request')
    // One pool, ranked: the first page is all of it.
    const { readers } = await readDiscover(deps, 'readers')
    return c.json(
      {
        readers: q.page === 1 ? readers.map((r) => v1ReaderCard(r, ctx)) : [],
        page: q.page,
        more: false,
      },
      200,
      q.cache,
    )
  })

  routes.get('/sites/:id', async (c) => {
    const q = await asked(c)
    const id = Number(c.req.param('id'))
    if (!q || !Number.isSafeInteger(id) || id <= 0) return refuse(c, 400, 'invalid_request')
    const page = await readSitePage(deps, id, q.page)
    if (!page) return refuse(c, 404, 'not_found')
    return c.json(
      {
        blog: v1BlogCard({ ...page.site, topics: page.topics }, ctx),
        feeds: page.feeds.map((f) => ({
          id: Number(f.id),
          title: (f.title as string | null) ?? null,
          feedUrl: String(f.feedUrl),
        })),
        posts: page.posts.map((p) => post(p, id, q.lang)),
        page: q.page,
        more: page.more,
      },
      200,
      q.cache,
    )
  })

  routes.get('/profiles/:handle', async (c) => {
    const q = await asked(c)
    if (!q) return refuse(c, 400, 'invalid_request')
    const page = await readProfile(deps, c.req.param('handle'), q.page)
    if (!page) return refuse(c, 404, 'not_found')
    const cards = page.subscriptions
      ? await readBlogCards(
          deps,
          page.subscriptions.map((s) => Number(s.id)),
        )
      : new Map<number, Row>()
    return c.json(
      {
        reader: { ...v1ReaderCard(page.profile, ctx), bio: page.profile.bio },
        recommendations: page.recommendations.map((r) => ({
          post: post(r.article, r.siteId, q.lang),
          note: 'note' in r ? ((r.note as string | null) ?? null) : null,
          createdAt: 'createdAt' in r ? Number(r.createdAt) : 0,
        })),
        ...(page.liked ? { likes: page.liked.map((r) => post(r.article, r.siteId, q.lang)) } : {}),
        ...(page.subscriptions
          ? {
              subscriptions: page.subscriptions.map((s) =>
                v1BlogCard(cards.get(Number(s.id)) ?? s, ctx),
              ),
            }
          : {}),
        page: q.page,
        more: page.more.recommendations || page.more.liked,
      },
      200,
      q.cache,
    )
  })

  routes.get('/blogrolls/:id', async (c) => {
    const q = await asked(c)
    if (!q) return refuse(c, 400, 'invalid_request')
    const page = await readBlogroll(deps, c.req.param('id'))
    if (!page) return refuse(c, 404, 'not_found')
    const cards = await readBlogCards(
      deps,
      page.blogs.map((b) => b.siteId),
    )
    return c.json(
      {
        id: page.blogroll.id,
        name: page.blogroll.name,
        description: page.blogroll.description || null,
        owner: v1ReaderCard(page.owner, ctx),
        blogs: page.blogs.map((b) => ({
          blog: v1BlogCard(
            cards.get(b.siteId) ?? {
              id: b.siteId,
              title: b.name,
              homeUrl: b.homeUrl,
              description: b.description,
              faviconKey: b.faviconKey,
              primaryLang: b.primaryLang,
              readerCount: b.readerCount,
            },
            ctx,
          ),
          feedId: b.feedId,
          note: b.note,
        })),
      },
      200,
      q.cache,
    )
  })

  routes.get('/search', async (c) => {
    const query = searchQuerySchema.safeParse(c.req.query())
    if (!query.success) return refuse(c, 400, 'invalid_request')
    const actor = actorOf(c)
    const lang = query.data.lang ?? (await memberLanguage(deps.db, actor.userId))
    const page = query.data.page ?? 1
    const found = await search(deps, actor, { q: query.data.q, lang: lang ?? undefined, page })
    const cards = await readBlogCards(
      deps,
      found.sites.map((s) => Number(s.id)),
    )
    return c.json(
      {
        posts: found.articles.map((a) => post(a, a.siteId, lang)),
        blogs: found.sites.map((s) => v1BlogCard(cards.get(Number(s.id)) ?? s, ctx)),
        page,
        more: found.more,
      },
      200,
      PRIVATE,
    )
  })

  routes.get('/articles/:id', async (c) => {
    const id = Number(c.req.param('id'))
    if (!Number.isSafeInteger(id) || id <= 0) return refuse(c, 400, 'invalid_request')
    const held = await readArticle(deps, actorOf(c), id)
    if (!held) return refuse(c, 404, 'not_found')
    return c.json(
      { article: v1Article(held.article), feed: v1Feed(held.feed), site: v1Site(held.site, ctx) },
      200,
      PRIVATE,
    )
  })

  return routes
}

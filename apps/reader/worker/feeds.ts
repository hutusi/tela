/**
 * Tela's own feeds rendered at the edge (ADR 0062), from tela-api's public JSON
 * (`/api/v1/public/feeds/*`), which carries each post's titles and excerpts in every launch
 * language it has. The edge picks one per `?hl=`, so the colo's one copy serves all four.
 *
 * Which title an item shows is the reader's rule for a public page (`shownTitle`, AGENTS.md):
 * the translation into the pinned language when there is one, else the title as written; never
 * a "translation" into the language a post is in. tela-api sends no translation of a blog that
 * opted out, and none made from a title the post no longer has. A feed with no `hl` is every post
 * as written. Its own words (the channel's title and description) are in its `hl`, else English.
 */
import { buildOpml, type OpmlFeed } from '@tela/content/opml'
import { buildRss, type RssItem } from '@tela/content/rss'
import { DEFAULT_UI_LOCALE, type UiLocale } from '@tela/shared'
import { createTranslator } from 'use-intl'
import { MESSAGES } from '../src/i18n'
import { type FeedRoute, feedPageHref, feedSelfHref } from '../src/lib/feed-href'
import { displayHost } from '../src/lib/format'

/** A blog as tela-api lists it in a feed (`FeedBlog` in `apps/api/src/routes/public-feeds.ts`). */
export type FeedBlog = { siteId: number; name: string | null; homeUrl: string; feedUrl: string }

/** A post as tela-api gives it to a feed (`FeedPost` there). */
export type FeedPost = {
  id: number
  url: string
  title: string
  excerpt: string | null
  sourceLang: string | null
  sortAt: number
  titles: Record<string, string>
  excerpts: Record<string, string>
  blog: FeedBlog
}

export type BlogrollFeedData = {
  blogroll: { id: string; name: string; description: string; updatedAt: number }
  owner: { handle: string; displayName: string | null }
  blogs: FeedBlog[]
  posts: FeedPost[]
}

export type DiscoverFeedData = { topic: string | null; blogs: FeedBlog[]; posts: FeedPost[] }

export type RenderedFeed = { body: string; type: string; filename: string | null }

export const RSS_TYPE = 'application/rss+xml; charset=utf-8'
export const OPML_TYPE = 'text/x-opml; charset=utf-8'

type Route = Exclude<FeedRoute, { kind: 'missing' }>

/**
 * A post's title and excerpt as a feed pinned to `hl` shows them: translated when a translation
 * into `hl` came with it, unless the post is in `hl` already; as written otherwise. The excerpt
 * follows the title: a translated excerpt beside the original title would mix the two.
 */
export function feedTitle(
  post: Pick<FeedPost, 'title' | 'excerpt' | 'sourceLang' | 'titles' | 'excerpts'>,
  hl: string | null,
): { title: string; excerpt: string | null } {
  const original = { title: post.title, excerpt: post.excerpt }
  if (!hl || post.sourceLang === hl) return original
  const title = post.titles?.[hl]
  if (!title) return original
  return { title, excerpt: post.excerpts?.[hl] || post.excerpt }
}

const web = (url: unknown): url is string => typeof url === 'string' && /^https?:\/\//i.test(url)

const blogName = (b: FeedBlog) => b.name || displayHost(b.homeUrl)

function items(posts: FeedPost[] | undefined, hl: string | null): RssItem[] {
  return (posts ?? [])
    .filter((p) => web(p.url))
    .map((p) => {
      const { title, excerpt } = feedTitle(p, hl)
      return {
        link: p.url,
        title,
        description: excerpt,
        creator: blogName(p.blog),
        sourceUrl: web(p.blog.feedUrl) ? p.blog.feedUrl : null,
        date: p.sortAt,
      }
    })
}

function outlines(blogs: FeedBlog[] | undefined): OpmlFeed[] {
  return (blogs ?? [])
    .filter((b) => web(b.feedUrl))
    .map((b) => ({ feedUrl: b.feedUrl, title: blogName(b), homeUrl: b.homeUrl }))
}

/** The feed a route names, from its endpoint's answer, with absolute links on `origin`. */
export function renderFeed(route: Route, data: unknown, origin: string): RenderedFeed {
  const locale: UiLocale = route.hl ?? DEFAULT_UI_LOCALE
  const t = createTranslator({ locale, messages: MESSAGES[locale] })
  const page = `${origin}${feedPageHref(route)}`
  const self = `${origin}${feedSelfHref(route)}`

  if (route.kind === 'blogroll') {
    const { blogroll, owner, blogs, posts } = data as BlogrollFeedData
    const by = owner.displayName ?? `@${owner.handle}`
    if (route.format === 'opml') {
      return {
        body: buildOpml(outlines(blogs), {
          title: blogroll.name,
          dateModified: new Date(blogroll.updatedAt),
          ownerName: by,
          ownerId: `${origin}/@${owner.handle}`,
        }),
        type: OPML_TYPE,
        filename: `tela-blogroll-${blogroll.id}.opml`,
      }
    }
    return {
      body: buildRss({
        title: blogroll.name,
        link: page,
        description:
          blogroll.description || t('feeds.blogroll', { name: blogroll.name, owner: by }),
        self,
        language: route.hl,
        items: items(posts, route.hl),
      }),
      type: RSS_TYPE,
      filename: null,
    }
  }

  const { blogs, posts } = data as DiscoverFeedData
  const title = [
    ...(route.topic ? [t(`discover.topics.${route.topic}`)] : []),
    t('nav.discover'),
    'Tela',
  ].join(' · ')
  if (route.format === 'opml') {
    return {
      body: buildOpml(outlines(blogs), { title }),
      type: OPML_TYPE,
      filename: route.topic ? `tela-discover-${route.topic}.opml` : 'tela-discover.opml',
    }
  }
  return {
    body: buildRss({
      title,
      link: page,
      description: t('feeds.discover'),
      self,
      language: route.hl,
      items: items(posts, route.hl),
    }),
    type: RSS_TYPE,
    filename: null,
  }
}

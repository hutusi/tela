/**
 * The head of a page the edge renders (ADR 0060): where it is canonical, its languages, how it
 * previews, whether it is indexed, and its structured data, for each kind of page.
 */
import { describe, expect, test } from 'bun:test'
import type { UiLocale } from '@tela/shared'
import { headTags, OG_LOCALES, pageAddresses } from '../src/lib/head'
import { type PublicRoute, publicRoute, renderPublicPage } from '../src/ssr'
import type {
  ArticlesData,
  BlogrollData,
  DiscoverData,
  DiscoverPost,
  FrontData,
  ProfileData,
  SiteData,
  WeekData,
} from '../src/views/types'

const ORIGIN = 'https://telaread.com'
const TEMPLATE = `<!doctype html>
<html lang="en">
  <head>
    <title>Tela</title>
    <meta name="description" content="Independent blogs, in any language." />
    <meta name="robots" content="noindex, nofollow" />
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>`

function render(path: string, data: unknown, locale: UiLocale = 'en') {
  const url = new URL(path, ORIGIN)
  return renderPublicPage({
    route: publicRoute(url) as PublicRoute,
    url,
    data,
    locale,
    now: Date.UTC(2026, 9, 25),
    template: TEMPLATE,
  })
}

const headOf = (html: string) => html.slice(0, html.indexOf('</head>'))
const attr = (html: string, pattern: RegExp) =>
  headOf(html).match(pattern)?.[1]?.replaceAll('&amp;', '&') ?? null
const canonical = (html: string) => attr(html, /<link rel="canonical" href="([^"]+)"/)
const robots = (html: string) => attr(html, /<meta name="robots" content="([^"]+)"/)
const og = (html: string, key: string) =>
  attr(html, new RegExp(`<meta property="${key}" content="([^"]+)"`))
const alternates = (html: string) =>
  [...headOf(html).matchAll(/<link rel="alternate" hreflang="([^"]+)" href="([^"]+)"/g)].map(
    (m) => [m[1], m[2]?.replaceAll('&amp;', '&')],
  )
/** The page's structured data, parsed: it must be JSON as it stands. */
function jsonLd(html: string): Record<string, unknown> {
  const raw = headOf(html).match(/<script type="application\/ld\+json">(.*?)<\/script>/s)?.[1]
  if (!raw) throw new Error('no JSON-LD')
  return JSON.parse(raw) as Record<string, unknown>
}

const article = (id: number, siteId: number, title = `Post ${id}`) => ({
  id,
  feedId: siteId,
  url: `https://blog${siteId}.example/${id}`,
  title,
  author: null,
  publishedAt: Date.UTC(2026, 9, 20),
  fetchedAt: 0,
  sortAt: 0,
  sourceLang: 'es',
  excerpt: null,
  contentKey: null,
  wordCount: 900,
  readingMinutes: 4,
  extractState: 'done' as const,
  likeCount: 0,
  recommendCount: 0,
  seq: 1,
  titles: { en: `${title} (en)`, fr: `${title} (fr)` },
})

const post = (id: number, siteId: number): DiscoverPost => ({
  article: article(id, siteId),
  site: {
    id: siteId,
    title: `Blog ${siteId}`,
    homeUrl: `https://blog${siteId}.example`,
    faviconKey: null,
    primaryLang: 'es',
    claimed: false,
  },
  weekRecs: 0,
  recommenders: [],
  note: null,
})

const SITE = (indexable?: boolean): SiteData => ({
  site: {
    id: 7,
    title: 'Ciudad',
    homeUrl: 'https://ciudad.example',
    description: 'Notes on cities.',
    faviconKey: null,
    primaryLang: 'es',
    readerCount: null,
    claimedBy: 'ana',
    claimant: { handle: 'ana', displayName: 'Ana', bio: null },
    postsLast30d: 2,
    ...(indexable === undefined ? {} : { indexable }),
  },
  feeds: [],
  posts: [article(1, 7, 'La noche'), { ...article(2, 7), url: null }],
  topics: [],
  notes: [],
})

const PROFILE = (indexable?: boolean): ProfileData => ({
  profile: {
    id: 'user-ann-0001',
    handle: 'ann',
    displayName: 'Ann K',
    bio: 'I read about cities.',
    avatar: '/avatar/user-ann-0001?v=2',
    memberSince: Date.UTC(2026, 8, 1),
    ...(indexable === undefined ? {} : { indexable }),
  },
  counts: null,
  blogs: [],
  recommendations: [],
  subscriptions: null,
  liked: null,
  blogrolls: [],
})

describe('the head builder', () => {
  const place = { origin: ORIGIN, locale: 'fr' as const, pinned: false }

  test('names every language at its ?hl= address, and the bare one as x-default', () => {
    const { canonical: bare, alternates: all } = pageAddresses('/discover/blogs?topic=tech', place)
    expect(bare).toBe(`${ORIGIN}/discover/blogs?topic=tech`)
    expect(all).toEqual([
      { hreflang: 'zh-Hans', href: `${ORIGIN}/discover/blogs?topic=tech&hl=zh-Hans` },
      { hreflang: 'zh-Hant', href: `${ORIGIN}/discover/blogs?topic=tech&hl=zh-Hant` },
      { hreflang: 'en', href: `${ORIGIN}/discover/blogs?topic=tech&hl=en` },
      { hreflang: 'fr', href: `${ORIGIN}/discover/blogs?topic=tech&hl=fr` },
      { hreflang: 'x-default', href: `${ORIGIN}/discover/blogs?topic=tech` },
    ])
    expect(pageAddresses('/about', { ...place, pinned: true }).canonical).toBe(
      `${ORIGIN}/about?hl=fr`,
    )
  })

  test('previews in the page language, with its card and the other three as alternates', () => {
    const html = headTags(
      { title: 'À propos', description: 'Ce qu’est Tela.', path: '/about', robots: null },
      place,
    ).join('\n')
    expect(og(html, 'og:locale')).toBe('fr_FR')
    expect([...html.matchAll(/og:locale:alternate" content="([^"]+)"/g)].map((m) => m[1])).toEqual([
      'zh_CN',
      'zh_TW',
      'en_US',
    ])
    expect(og(html, 'og:image')).toBe(`${ORIGIN}/og/fr.png`)
    expect(og(html, 'og:site_name')).toBe('Tela')
    expect(og(html, 'og:url')).toBe(`${ORIGIN}/about`)
    expect(html).toContain('<meta name="twitter:card" content="summary_large_image" />')
    expect(html).toContain('<meta property="og:description" content="Ce qu’est Tela." />')
    expect(Object.values(OG_LOCALES)).toHaveLength(4)
  })

  test('a page kept out of the index names no canonical and no languages, only its rule', () => {
    const html = headTags(
      { title: 'x', description: null, path: '/s/1', robots: 'noindex, nofollow' },
      place,
    ).join('\n')
    expect(robots(html)).toBe('noindex, nofollow')
    expect(canonical(html)).toBeNull()
    expect(alternates(html)).toEqual([])
    expect(og(html, 'og:url')).toBe(`${ORIGIN}/s/1`)
  })

  test("a route's feeds are alternates of their own, absolute", () => {
    const html = headTags(
      {
        title: 'x',
        description: null,
        path: '/l/abc',
        robots: null,
        feeds: [
          { type: 'application/rss+xml', title: 'Posts', href: '/l/abc.rss' },
          { type: 'text/x-opml', title: 'Blogs', href: 'https://elsewhere.example/x.opml' },
        ],
      },
      place,
    ).join('\n')
    expect(html).toContain(
      `<link rel="alternate" type="application/rss+xml" title="Posts" href="${ORIGIN}/l/abc.rss" />`,
    )
    expect(html).toContain('href="https://elsewhere.example/x.opml"')
  })
})

describe('each kind of page', () => {
  test('the front page is the website, in four languages', () => {
    const front: FrontData = {
      counts: { blogs: 3 },
      week: { blogs: 1, languages: 1, posts: 1 },
      edition: { span: 'week', posts: [] },
    }
    const html = render('/?hl=zh-Hans&utm_source=x', front, 'zh-Hans')
    expect(canonical(html)).toBe(`${ORIGIN}/?hl=zh-Hans`)
    expect(alternates(html).at(-1)).toEqual(['x-default', `${ORIGIN}/`])
    expect(robots(html)).toBeNull()
    expect(jsonLd(html)).toMatchObject({
      '@context': 'https://schema.org',
      '@type': 'WebSite',
      name: 'Tela',
      url: `${ORIGIN}/`,
      inLanguage: ['zh-Hans', 'zh-Hant', 'en', 'fr'],
    })
    expect(og(html, 'og:image')).toBe(`${ORIGIN}/og/zh-Hans.png`)
  })

  test('an info page is canonical at its own path, whatever else was asked', () => {
    const html = render('/privacy?ref=x', {})
    expect(canonical(html)).toBe(`${ORIGIN}/privacy`)
    expect(headOf(html)).not.toContain('application/ld+json')
  })

  test('For writers is indexed at its own path, in every language, and previews as itself', () => {
    const html = render('/writers?utm_source=x', {})
    expect(canonical(html)).toBe(`${ORIGIN}/writers`)
    expect(robots(html)).toBeNull()
    expect(alternates(html)).toEqual([
      ['zh-Hans', `${ORIGIN}/writers?hl=zh-Hans`],
      ['zh-Hant', `${ORIGIN}/writers?hl=zh-Hant`],
      ['en', `${ORIGIN}/writers?hl=en`],
      ['fr', `${ORIGIN}/writers?hl=fr`],
      ['x-default', `${ORIGIN}/writers`],
    ])
    expect(og(html, 'og:title')).toBe('For writers')
    expect(og(html, 'og:url')).toBe(`${ORIGIN}/writers`)
    const fr = render('/writers?hl=fr', {}, 'fr')
    expect(canonical(fr)).toBe(`${ORIGIN}/writers?hl=fr`)
    expect(og(fr, 'og:title')).toBe('Pour les auteurs')
    expect(og(fr, 'og:image')).toBe(`${ORIGIN}/og/fr.png`)
  })

  test('How Tela reads your blog is indexed at its own path, in every language (ADR 0070)', () => {
    const html = render('/bot?utm_source=x', {})
    expect(canonical(html)).toBe(`${ORIGIN}/bot`)
    expect(robots(html)).toBeNull()
    expect(alternates(html)).toContainEqual(['zh-Hant', `${ORIGIN}/bot?hl=zh-Hant`])
    expect(og(html, 'og:title')).toBe('How Tela reads your blog')
    const zh = render('/bot?hl=zh-Hans', {}, 'zh-Hans')
    expect(canonical(zh)).toBe(`${ORIGIN}/bot?hl=zh-Hans`)
    expect(og(zh, 'og:title')).toBe('Tela 如何读取你的博客')
  })

  test("Discover's tabs are collections of what they show, posts at their own addresses", () => {
    const week: WeekData = {
      since: 0,
      recommended: [],
      edition: { span: 'week', posts: [post(1, 1), post(2, 2)] },
      newBlogs: [],
      readers: [],
    }
    const html = render('/discover?hl=fr', week, 'fr')
    expect(canonical(html)).toBe(`${ORIGIN}/discover?hl=fr`)
    expect(jsonLd(html)).toMatchObject({
      '@type': 'CollectionPage',
      inLanguage: 'fr',
      mainEntity: {
        '@type': 'ItemList',
        numberOfItems: 2,
        itemListElement: [
          { '@type': 'ListItem', position: 1, url: 'https://blog1.example/1', name: 'Post 1 (fr)' },
          { '@type': 'ListItem', position: 2, url: 'https://blog2.example/2', name: 'Post 2 (fr)' },
        ],
      },
    })
    const blogs: DiscoverData = {
      sites: [
        {
          id: 4,
          title: null,
          homeUrl: 'https://www.quiet.example',
          description: null,
          faviconKey: null,
          primaryLang: 'en',
          claimed: false,
          readerCount: null,
          feedId: 4,
          latestTitle: null,
          latestAt: null,
          postsLast30d: 0,
          topics: [],
        },
      ],
      languages: [],
    }
    const list = jsonLd(render('/discover/blogs?topic=tech', blogs)).mainEntity as {
      itemListElement: unknown[]
    }
    expect(list.itemListElement).toEqual([
      { '@type': 'ListItem', position: 1, url: `${ORIGIN}/s/4`, name: 'quiet.example' },
    ])
  })

  test("a page past Discover's cursor is followed, not indexed", () => {
    const page: ArticlesData = { recommended: [], posts: [post(3, 1)], next: null, languages: [] }
    expect(robots(render('/discover/articles?sort=new&cursor=100:3', page))).toBe('noindex')
    expect(robots(render('/discover/articles?sort=new', page))).toBeNull()
    // Blogs pages by number: its second page is as much a slice as a cursor's.
    const blogs: DiscoverData = { sites: [], languages: [], total: 120, pageSize: 50 }
    expect(robots(render('/discover/blogs?topic=tech&page=2', blogs))).toBe('noindex')
    expect(canonical(render('/discover/blogs?topic=tech&page=2', blogs))).toBeNull()
    expect(robots(render('/discover/blogs?topic=tech', blogs))).toBeNull()
    expect(robots(render('/discover/blogs?page=1', blogs))).toBeNull()
    expect(canonical(render('/discover/articles?sort=new&hl=en', page, 'en'))).toBe(
      `${ORIGIN}/discover/articles?sort=new&hl=en`,
    )
  })

  test('a blog is indexed once an operator listed it, and its data names the blog where it lives', () => {
    const listed = render('/s/7', SITE(true))
    expect(robots(listed)).toBeNull()
    expect(canonical(listed)).toBe(`${ORIGIN}/s/7`)
    expect(jsonLd(listed)).toEqual({
      '@context': 'https://schema.org',
      '@type': 'Blog',
      name: 'Ciudad',
      url: 'https://ciudad.example',
      description: 'Notes on cities.',
      inLanguage: 'es',
      author: { '@type': 'Person', name: 'Ana', url: `${ORIGIN}/@ana` },
      blogPost: [
        {
          '@type': 'BlogPosting',
          // As written, beside the language it is in: never the visitor's translation.
          headline: 'La noche',
          url: 'https://blog7.example/1',
          datePublished: '2026-10-20T00:00:00.000Z',
          inLanguage: 'es',
        },
      ],
    })
    // Claimed and never reviewed, or a tela-api that does not say: neither indexed nor followed.
    for (const unvouched of [SITE(false), SITE()]) {
      const html = render('/s/7', unvouched)
      expect(robots(html)).toBe('noindex, nofollow')
      expect(canonical(html)).toBeNull()
    }
  })

  test('a profile is a profile page, indexed once tela-api says so', () => {
    const html = render('/@ann?tab=liked&hl=en', PROFILE(true), 'en')
    expect(canonical(html)).toBe(`${ORIGIN}/@ann?tab=liked&hl=en`)
    expect(og(html, 'og:type')).toBe('profile')
    expect(og(html, 'profile:username')).toBe('ann')
    expect(jsonLd(html)).toEqual({
      '@context': 'https://schema.org',
      '@type': 'ProfilePage',
      url: `${ORIGIN}/@ann?tab=liked`,
      dateCreated: '2026-09-01T00:00:00.000Z',
      mainEntity: {
        '@type': 'Person',
        name: 'Ann K',
        alternateName: '@ann',
        url: `${ORIGIN}/@ann`,
        description: 'I read about cities.',
        image: `${ORIGIN}/avatar/user-ann-0001?v=2`,
      },
    })
    expect(robots(render('/@ann', PROFILE(false)))).toBe('noindex, nofollow')
    expect(robots(render('/@ann', PROFILE()))).toBe('noindex, nofollow')
  })

  test('a blogroll is a collection of its blogs, each at its page on Tela or at home', () => {
    const roll: BlogrollData = {
      blogroll: {
        id: 'abcdefABCDEF',
        name: 'Cities',
        description: '',
        updatedAt: 0,
        indexable: true,
      },
      owner: { id: 'user-ann-0001', handle: 'ann', displayName: null },
      blogs: [
        {
          feedId: 1,
          siteId: 1,
          name: 'Calle',
          homeUrl: 'https://calle.example',
          faviconKey: null,
          primaryLang: 'es',
          description: null,
          listed: true,
          readerCount: null,
          dead: false,
          note: null,
          addedAt: 0,
        },
        {
          feedId: 2,
          siteId: 2,
          name: null,
          homeUrl: 'https://kerbs.example',
          faviconKey: null,
          primaryLang: 'en',
          description: null,
          listed: false,
          readerCount: null,
          dead: false,
          note: null,
          addedAt: 0,
        },
      ],
    }
    const html = render('/l/abcdefABCDEF', roll)
    expect(robots(html)).toBeNull()
    expect(jsonLd(html)).toMatchObject({
      '@type': 'CollectionPage',
      name: 'Cities',
      description: 'A blogroll by @ann',
      author: { '@type': 'Person', name: '@ann', url: `${ORIGIN}/@ann` },
      mainEntity: {
        numberOfItems: 2,
        itemListElement: [
          { position: 1, url: `${ORIGIN}/s/1`, name: 'Calle' },
          { position: 2, url: 'https://kerbs.example', name: 'kerbs.example' },
        ],
      },
    })
    const hidden = { ...roll, blogroll: { ...roll.blogroll, indexable: false } }
    expect(robots(render('/l/abcdefABCDEF', hidden))).toBe('noindex, nofollow')
  })

  test('a page that does not exist is not indexed and names no address', () => {
    const html = render('/s/9', null)
    expect(robots(html)).toBe('noindex')
    expect(canonical(html)).toBeNull()
    expect(og(html, 'og:url')).toBeNull()
  })

  test("nothing a blog says can close the structured data's script", () => {
    const evil = SITE(true)
    evil.site.title = '</script><script>alert(1)</script>'
    const html = render('/s/7', evil)
    expect(headOf(html)).not.toContain('<script>alert(1)')
    expect(jsonLd(html).name).toBe('</script><script>alert(1)</script>')
  })
})

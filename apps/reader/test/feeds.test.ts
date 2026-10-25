/**
 * Tela's own feeds' addresses and titles (ADR 0062): which URL is which feed, the `?hl=` it pins,
 * the links the pages make, and the title an item shows. The edge serving them, from tela-api's
 * answers, is in `edge.test.ts`.
 */
import { describe, expect, test } from 'bun:test'
import {
  blogrollFeedHref,
  discoverFeedHref,
  feedPageHref,
  feedRoute,
  feedSelfHref,
  parseHl,
} from '../src/lib/feed-href'
import { feedTitle } from '../worker/feeds'

const route = (path: string) => feedRoute(new URL(path, 'https://tela.test'))

describe('?hl=', () => {
  test('is one of the four interface languages, in any case, given back as Tela writes it', () => {
    expect(parseHl('fr')).toBe('fr')
    expect(parseHl('EN')).toBe('en')
    expect(parseHl('zh-hans')).toBe('zh-Hans')
    expect(parseHl(' ZH-HANT ')).toBe('zh-Hant')
    for (const other of ['', null, undefined, 'de', 'zh', 'zh-CN', 'zh-TW', 'fr-FR', 'en,fr'])
      expect(parseHl(other)).toBeNull()
  })
})

describe('which feed a URL names', () => {
  test("a blogroll's, by its id and format, read from its own endpoint", () => {
    expect(route('/l/abcdefABCDEF.rss?hl=ZH-hant&utm_source=x')).toEqual({
      kind: 'blogroll',
      id: 'abcdefABCDEF',
      format: 'rss',
      hl: 'zh-Hant',
      api: '/api/v1/public/feeds/blogrolls/abcdefABCDEF',
    })
    expect(route('/l/abcdefABCDEF.opml')).toMatchObject({ format: 'opml', hl: null })
    // A feed's name of no blogroll's shape is a 404; the page and anything else are not feeds.
    for (const path of ['/l/short.rss', '/l/abcdefABCDE-.opml', '/l/.rss'])
      expect(route(path)).toEqual({ kind: 'missing' })
    for (const path of ['/l/abcdefABCDEF', '/l/abcdefABCDEF.xml', '/l/a/b.rss', '/x.rss'])
      expect(route(path)).toBeNull()
  })

  test("Discover's two, by topic, one endpoint for both: the language is the edge's to pick", () => {
    expect(route('/discover/articles.rss?topic=tech&hl=fr')).toEqual({
      kind: 'discover',
      format: 'rss',
      topic: 'tech',
      hl: 'fr',
      api: '/api/v1/public/feeds/discover?topic=tech',
    })
    expect(route('/discover.opml?topic=nope')).toEqual({
      kind: 'discover',
      format: 'opml',
      topic: null,
      hl: null,
      api: '/api/v1/public/feeds/discover',
    })
    for (const path of ['/discover', '/discover/articles', '/discover/blogs.opml'])
      expect(route(path)).toBeNull()
  })

  test('the links the pages make name the feeds they are, and each feed says where it is', () => {
    expect(blogrollFeedHref('abcdefABCDEF', 'rss', 'fr')).toBe('/l/abcdefABCDEF.rss?hl=fr')
    // A blogroll's OPML is its blogs' own names: no language changes it.
    expect(blogrollFeedHref('abcdefABCDEF', 'opml', 'fr')).toBe('/l/abcdefABCDEF.opml')
    expect(discoverFeedHref('rss', { topic: 'tech', hl: 'zh-Hant' })).toBe(
      '/discover/articles.rss?topic=tech&hl=zh-Hant',
    )
    expect(discoverFeedHref('opml', { topic: 'nope' })).toBe('/discover.opml')
    for (const href of [
      blogrollFeedHref('abcdefABCDEF', 'rss', 'fr'),
      blogrollFeedHref('abcdefABCDEF', 'opml'),
      discoverFeedHref('rss', { topic: 'tech', hl: 'zh-Hant' }),
      discoverFeedHref('opml', { hl: 'en' }),
    ]) {
      const named = route(href)
      if (!named || named.kind === 'missing') throw new Error(href)
      expect(feedSelfHref(named)).toBe(href)
    }
    const rss = route('/discover/articles.rss?hl=fr&topic=tech')
    const opml = route('/discover.opml?topic=tech')
    const roll = route('/l/abcdefABCDEF.rss?hl=en')
    if (rss?.kind !== 'discover' || opml?.kind !== 'discover' || roll?.kind !== 'blogroll')
      throw new Error('routes')
    expect(feedPageHref(rss)).toBe('/discover/articles?topic=tech&sort=new&hl=fr')
    expect(feedPageHref(opml)).toBe('/discover/blogs?topic=tech')
    expect(feedPageHref(roll)).toBe('/l/abcdefABCDEF?hl=en')
  })
})

describe("an item's title", () => {
  const post = {
    title: 'Walking Lisbon',
    excerpt: 'On foot.',
    sourceLang: 'en',
    titles: { fr: 'Marcher à Lisbonne', 'zh-Hant': '漫步里斯本' },
    excerpts: { fr: 'À pied.' },
  }

  test('is the translation into the pinned language, its excerpt with it, else as written', () => {
    expect(feedTitle(post, 'fr')).toEqual({ title: 'Marcher à Lisbonne', excerpt: 'À pied.' })
    // A title translated without its excerpt keeps the excerpt as written.
    expect(feedTitle(post, 'zh-Hant')).toEqual({ title: '漫步里斯本', excerpt: 'On foot.' })
    expect(feedTitle(post, 'zh-Hans')).toEqual({ title: 'Walking Lisbon', excerpt: 'On foot.' })
    expect(feedTitle(post, null)).toEqual({ title: 'Walking Lisbon', excerpt: 'On foot.' })
  })

  test('is never a translation into the language the post is in', () => {
    expect(feedTitle({ ...post, sourceLang: 'fr' }, 'fr').title).toBe('Walking Lisbon')
    // zh-Hans and zh-Hant are two languages: a Simplified post reads in Traditional converted.
    expect(feedTitle({ ...post, sourceLang: 'zh-Hans' }, 'zh-Hant').title).toBe('漫步里斯本')
    // A post whose language nobody knows takes the translation, as the reader's lists do.
    expect(feedTitle({ ...post, sourceLang: null }, 'fr').title).toBe('Marcher à Lisbonne')
  })
})

import { describe, expect, test } from 'bun:test'
import { XMLValidator } from 'fast-xml-parser'
import { parseRssFeed } from 'feedsmith'
import { parseFeedText } from './feed'
import { buildRss, type RssChannel } from './rss'

const AT = Date.UTC(2026, 9, 25, 12)

const channel = (over: Partial<RssChannel> = {}): RssChannel => ({
  title: 'Cities, on foot',
  link: 'https://tela.test/l/Abc123def456?hl=fr',
  description: 'Blogs by people who walk their cities.',
  self: 'https://tela.test/l/Abc123def456.rss?hl=fr',
  language: 'fr',
  items: [
    {
      link: 'https://a.example/posts/1?x=1&y=2',
      title: 'Marcher à Paris',
      description: 'Un extrait.',
      creator: 'Blog A',
      sourceUrl: 'https://a.example/feed',
      date: AT,
    },
    { link: 'https://b.example/2', title: 'Older', date: AT - 86_400_000 },
  ],
  ...over,
})

describe('buildRss', () => {
  test('a well-formed RSS 2.0 document that a feed reader, and Tela itself, read back', () => {
    const doc = buildRss(channel())
    expect(XMLValidator.validate(doc)).toBe(true)
    const feed = parseRssFeed(doc)
    expect(feed.title).toBe('Cities, on foot')
    expect(feed.link).toBe('https://tela.test/l/Abc123def456?hl=fr')
    expect(feed.language).toBe('fr')
    expect(feed.atom?.links?.[0]).toEqual({
      href: 'https://tela.test/l/Abc123def456.rss?hl=fr',
      rel: 'self',
      type: 'application/rss+xml',
    })
    const [first, second] = feed.items ?? []
    expect(first?.title).toBe('Marcher à Paris')
    expect(first?.link).toBe('https://a.example/posts/1?x=1&y=2')
    expect(first?.guid).toEqual({ value: 'https://a.example/posts/1?x=1&y=2', isPermaLink: true })
    expect(first?.dc?.creator).toBe('Blog A')
    expect(first?.source).toEqual({ title: 'Blog A', url: 'https://a.example/feed' })
    expect(first?.pubDate).toBe('Sun, 25 Oct 2026 12:00:00 GMT')
    // No blog name, no source; no excerpt, no description.
    expect(second?.dc).toBeUndefined()
    expect(second?.source).toBeUndefined()
    expect(second?.description).toBeUndefined()
    // The newest item's date, not the time it was written: the same items, the same bytes.
    expect(doc).toContain('<lastBuildDate>Sun, 25 Oct 2026 12:00:00 GMT</lastBuildDate>')
    expect(buildRss(channel())).toBe(doc)
    // Tela's own ingest reads it as any feed.
    const read = parseFeedText(doc, 'https://tela.test/l/Abc123def456.rss')
    expect(read.format).toBe('rss')
    expect(read.selfUrl).toBe('https://tela.test/l/Abc123def456.rss?hl=fr')
    expect(read.items.map((i) => [i.url, i.title, i.author, i.publishedAt?.getTime()])).toEqual([
      ['https://a.example/posts/1?x=1&y=2', 'Marcher à Paris', 'Blog A', AT],
      ['https://b.example/2', 'Older', null, AT - 86_400_000],
    ])
  })

  test('hostile titles, names and excerpts are text, never markup, and never break the document', () => {
    const hostile = '</title><script>alert(1)</script> & "q" \'s ]]> \u0000\u0008\uFFFE'
    const doc = buildRss(
      channel({
        title: hostile,
        description: hostile,
        items: [
          {
            link: 'https://a.example/?a=1&b=<2>',
            title: hostile,
            description: `<img src=x onerror=alert(1)> ${hostile}`,
            creator: hostile,
            sourceUrl: 'https://a.example/feed?"x"',
            date: AT,
          },
        ],
      }),
    )
    expect(XMLValidator.validate(doc)).toBe(true)
    expect(doc).not.toContain('<script>')
    expect(doc).not.toContain('<img')
    for (const c of [0x0, 0x8, 0xfffe]) expect(doc).not.toContain(String.fromCodePoint(c))
    const feed = parseRssFeed(doc)
    const clean = '</title><script>alert(1)</script> & "q" \'s ]]>'
    expect(feed.title).toBe(clean)
    const [item] = feed.items ?? []
    expect(item?.title).toBe(clean)
    expect(item?.dc?.creator).toBe(clean)
    expect(item?.link).toBe('https://a.example/?a=1&b=<2>')
    // A description is HTML to a reader: the excerpt's own angle brackets arrive escaped for it.
    expect(item?.description).toBe(
      '&lt;img src=x onerror=alert(1)&gt; &lt;/title&gt;&lt;script&gt;alert(1)&lt;/script&gt; &amp; "q" \'s ]]&gt;',
    )
  })

  test('an untitled post is titled by its link; an empty channel is still a channel', () => {
    const doc = buildRss(
      channel({ language: null, items: [{ link: 'https://a.example/1', title: '  ', date: AT }] }),
    )
    expect(XMLValidator.validate(doc)).toBe(true)
    expect(parseRssFeed(doc).items?.[0]?.title).toBe('https://a.example/1')
    expect(doc).not.toContain('<language>')
    const empty = buildRss(channel({ items: [] }))
    expect(XMLValidator.validate(empty)).toBe(true)
    expect(empty).not.toContain('lastBuildDate')
    expect(parseRssFeed(empty).items ?? []).toEqual([])
  })
})

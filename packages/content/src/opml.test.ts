import { describe, expect, test } from 'bun:test'
import { buildOpml, feedUrlsFromOpml, MAX_OPML_DEPTH, MAX_OPML_FEEDS } from './opml'

function opml(body: string): string {
  return `<?xml version="1.0"?><opml version="2.0"><head><title>subs</title></head><body>${body}</body></opml>`
}

describe('feedUrlsFromOpml', () => {
  test('collects http(s) feed URLs from nested folders, in order, without duplicates', () => {
    const urls = feedUrlsFromOpml(
      opml(`
        <outline text="Tech">
          <outline text="A" xmlUrl="https://a.example/feed"/>
          <outline text="B" xmlUrl="https://b.example/feed"/>
          <outline text="Nested"><outline text="C" xmlUrl="https://c.example/feed"/></outline>
        </outline>
        <outline text="A again" xmlUrl="https://a.example/feed"/>
        <outline text="odd" xmlUrl="ftp://x.example/feed"/>
        <outline text="no url"/>
      `),
    )
    expect(urls).toEqual([
      'https://a.example/feed',
      'https://b.example/feed',
      'https://c.example/feed',
    ])
  })

  test('ignores outlines nested past the depth limit and stops at the feed cap', () => {
    let deep = '<outline text="deep" xmlUrl="https://deep.example/feed"/>'
    for (let i = 0; i <= MAX_OPML_DEPTH; i++) deep = `<outline text="f${i}">${deep}</outline>`
    expect(feedUrlsFromOpml(opml(deep))).toEqual([])
    const many = Array.from(
      { length: MAX_OPML_FEEDS + 50 },
      (_, i) => `<outline text="${i}" xmlUrl="https://f.example/${i}"/>`,
    ).join('')
    expect(feedUrlsFromOpml(opml(many))).toHaveLength(MAX_OPML_FEEDS)
  })

  test('rejects input that is not OPML', () => {
    expect(() => feedUrlsFromOpml('<html><body>nope</body></html>')).toThrow()
    expect(() => feedUrlsFromOpml('not xml at all')).toThrow()
  })
})

describe('buildOpml', () => {
  test('writes what feedUrlsFromOpml reads back, escaping titles and URLs', () => {
    const doc = buildOpml(
      [
        {
          feedUrl: 'https://a.example/feed?x=1&y=2',
          title: 'A & "B"',
          homeUrl: 'https://a.example',
        },
        { feedUrl: 'https://b.example/feed', title: '<b>', homeUrl: 'https://b.example' },
      ],
      new Date(Date.UTC(2026, 8, 28)),
    )
    expect(doc).toContain('text="A &amp; &quot;B&quot;"')
    expect(feedUrlsFromOpml(doc)).toEqual([
      'https://a.example/feed?x=1&y=2',
      'https://b.example/feed',
    ])
  })
})

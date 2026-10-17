import { describe, expect, test } from 'bun:test'
import { FOLDER_NAME_MAX } from '@tela/shared'
import { buildOpml, feedsFromOpml, feedUrlsFromOpml, MAX_OPML_DEPTH, MAX_OPML_FEEDS } from './opml'

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

describe('feedsFromOpml', () => {
  test("files each feed in the nearest folder around it, and the first listing's folder wins", () => {
    expect(
      feedsFromOpml(
        opml(`
          <outline text="Tech">
            <outline text="A" xmlUrl="https://a.example/feed"/>
            <outline text="Nested"><outline text="C" xmlUrl="https://c.example/feed"/></outline>
          </outline>
          <outline text="Cities"><outline text="A again" xmlUrl="https://a.example/feed"/></outline>
          <outline text="Top" xmlUrl="https://top.example/feed"/>
        `),
      ),
    ).toEqual([
      { url: 'https://a.example/feed', folder: 'Tech' },
      { url: 'https://c.example/feed', folder: 'Nested' },
      { url: 'https://top.example/feed', folder: null },
    ])
  })

  test('names a folder by its text, else its title, as a folder name is kept', () => {
    const long = 'x'.repeat(FOLDER_NAME_MAX + 10)
    expect(
      feedsFromOpml(
        opml(`
          <outline title="Only a  title "><outline text="A" xmlUrl="https://a.example/feed"/></outline>
          <outline text="  Both " title="Ignored"><outline text="B" xmlUrl="https://b.example/feed"/></outline>
          <outline text="${long}"><outline text="C" xmlUrl="https://c.example/feed"/></outline>
          <outline text="Caf&#233; &amp; Bar"><outline text="D" xmlUrl="https://d.example/feed"/></outline>
        `),
      ).map((f) => f.folder),
    ).toEqual(['Only a title', 'Both', 'x'.repeat(FOLDER_NAME_MAX), 'Café & Bar'])
  })

  test('a feed whose nearest folder has no name is in none, not in one further out', () => {
    expect(
      feedsFromOpml(
        opml(`
          <outline text="Tech">
            <outline text="  "><outline text="A" xmlUrl="https://a.example/feed"/></outline>
            <outline><outline text="B" xmlUrl="https://b.example/feed"/></outline>
          </outline>
        `),
      ),
    ).toEqual([
      { url: 'https://a.example/feed', folder: null },
      { url: 'https://b.example/feed', folder: null },
    ])
  })

  test('a feed is no folder: what a reader nested under one is in the folder around it', () => {
    expect(
      feedsFromOpml(
        opml(`
          <outline text="Tech">
            <outline text="A" xmlUrl="https://a.example/feed">
              <outline text="B" xmlUrl="https://b.example/feed"/>
            </outline>
          </outline>
        `),
      ),
    ).toEqual([
      { url: 'https://a.example/feed', folder: 'Tech' },
      { url: 'https://b.example/feed', folder: 'Tech' },
    ])
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

  test('groups each folder where its first feed is, then the feeds in none, and reads back', () => {
    const feed = (name: string, folder: string | null = null) => ({
      feedUrl: `https://${name}.example/feed`,
      title: name,
      homeUrl: `https://${name}.example`,
      folder,
    })
    const doc = buildOpml(
      [
        feed('a', 'Tech'),
        feed('loose'),
        feed('b', 'Cities & <Towns>'),
        feed('c', 'Tech'),
        feed('none', null),
      ],
      new Date(Date.UTC(2026, 8, 28)),
    )
    expect(doc).toContain(
      '<outline text="Cities &amp; &lt;Towns&gt;" title="Cities &amp; &lt;Towns&gt;">',
    )
    // A folder is an outline of its own with no xmlUrl, so no reader takes it for a feed.
    expect(doc).toMatch(/<outline text="Tech" title="Tech">\n\s+<outline type="rss" text="a"/)
    expect(feedsFromOpml(doc)).toEqual([
      { url: 'https://a.example/feed', folder: 'Tech' },
      { url: 'https://c.example/feed', folder: 'Tech' },
      { url: 'https://b.example/feed', folder: 'Cities & <Towns>' },
      { url: 'https://loose.example/feed', folder: null },
      { url: 'https://none.example/feed', folder: null },
    ])
  })
})

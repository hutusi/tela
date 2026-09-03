import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { dedupKey } from './dedup'
import { looksLikeFeed, parseFeedText } from './feed'
import { FIXTURE_FEEDS, FIXTURES_DIR } from './fixtures.test-helper'

describe('parseFeedText on captured feeds', () => {
  const files = readdirSync(FIXTURES_DIR).filter((f) => /\.(xml|json)$/.test(f))

  test('every fixture is listed with its source URL', () => {
    for (const file of files)
      expect(FIXTURE_FEEDS[file], `missing SOURCE entry for ${file}`).toBeDefined()
  })

  for (const file of files) {
    test(`${file} parses with items, titles, and unique dedup keys`, async () => {
      const text = readFileSync(join(FIXTURES_DIR, file), 'utf8')
      const url = FIXTURE_FEEDS[file] as string
      expect(looksLikeFeed(text)).toBe(true)
      const feed = parseFeedText(text, url)
      const expectedFormat = file.includes('.feed.json')
        ? 'json'
        : file.includes('.rdf.')
          ? 'rdf'
          : file.includes('.atom.')
            ? 'atom'
            : 'rss'
      expect(feed.format).toBe(expectedFormat)
      expect(feed.title).toBeTruthy()
      expect(feed.homeUrl).toMatch(/^https?:\/\//)
      expect(feed.items.length).toBeGreaterThan(0)
      const keys = new Set<string>()
      for (const item of feed.items) {
        expect(item.url ?? item.guid).toBeTruthy()
        expect(
          item.title.length + (item.summaryHtml ?? item.contentHtml ?? '').length,
        ).toBeGreaterThan(0)
        if (item.url) expect(item.url).toMatch(/^https?:\/\//)
        keys.add(await dedupKey(item))
      }
      expect(keys.size).toBe(feed.items.length)
    })
  }
})

describe('parseFeedText specifics', () => {
  test('Atom feed with xml:base resolves absolute links', () => {
    const feed = parseFeedText(
      readFileSync(join(FIXTURES_DIR, 'daringfireball.atom.xml'), 'utf8'),
      'https://daringfireball.net/feeds/main',
    )
    expect(feed.homeUrl).toBe('https://daringfireball.net/')
    // Linked-list posts point their alternate link at the external article; own posts
    // point at daringfireball.net. Both must resolve to absolute URLs.
    for (const item of feed.items) expect(item.url).toMatch(/^https?:\/\//)
    expect(feed.items.some((i) => i.url?.startsWith('https://daringfireball.net/'))).toBe(true)
    expect(feed.items[0]?.contentHtml).toBeTruthy()
  })

  test('JSON Feed items carry content_html and dates', () => {
    const feed = parseFeedText(
      readFileSync(join(FIXTURES_DIR, 'jimnielsen.feed.json'), 'utf8'),
      'https://blog.jim-nielsen.com/feed.json',
    )
    expect(feed.format).toBe('json')
    expect(feed.items[0]?.contentHtml).toContain('<')
    expect(feed.items[0]?.publishedAt).toBeInstanceOf(Date)
  })

  test('WordPress RSS exposes content:encoded separately from the description', () => {
    const feed = parseFeedText(
      readFileSync(join(FIXTURES_DIR, 'joelonsoftware.rss.xml'), 'utf8'),
      'https://www.joelonsoftware.com/feed/',
    )
    const item = feed.items[0]
    expect(item?.contentHtml).toBeTruthy()
    expect(item?.summaryHtml).toBeTruthy()
    expect((item?.contentHtml ?? '').length).toBeGreaterThan((item?.summaryHtml ?? '').length)
  })

  test('rejects non-feed input', () => {
    expect(looksLikeFeed('<html><body>hi</body></html>')).toBe(false)
    expect(() => parseFeedText('<html><body>hi</body></html>', 'https://x.example/')).toThrow()
  })

  test('JSON Feed content_text becomes paragraphs', () => {
    const json = JSON.stringify({
      version: 'https://jsonfeed.org/version/1.1',
      title: 'T',
      home_page_url: 'https://t.example/',
      items: [{ id: '1', url: 'https://t.example/1', content_text: 'one\ntwo\n\nthree <b>' }],
    })
    const feed = parseFeedText(json, 'https://t.example/feed.json')
    expect(feed.items[0]?.contentHtml).toBe('<p>one<br>two</p><p>three &lt;b&gt;</p>')
  })
})

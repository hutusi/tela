import { describe, expect, test } from 'bun:test'
import { candidateFeedUrls, findFeedLinks, findMetaRefresh } from './discover'

describe('discover', () => {
  test('finds declared alternates before anchors and dedupes', () => {
    const html = `
      <html><head>
        <link rel="alternate" type="application/rss+xml" title="RSS" href="/feed/">
        <link rel="alternate" type="application/atom+xml; charset=utf-8" href="https://blog.example/atom.xml">
        <link rel="stylesheet" href="/style.css">
        <link rel="alternate" type="text/html" hreflang="zh" href="/zh/">
      </head><body>
        <a href="/feed/">Subscribe</a>
        <a href="https://other.example/rss.xml">Other</a>
        <a href="/about">About</a>
      </body></html>`
    expect(findFeedLinks(html, 'https://blog.example/posts/1')).toEqual([
      {
        url: 'https://blog.example/feed/',
        title: 'RSS',
        type: 'application/rss+xml',
        source: 'link',
      },
      {
        url: 'https://blog.example/atom.xml',
        title: null,
        type: 'application/atom+xml',
        source: 'link',
      },
      { url: 'https://other.example/rss.xml', title: 'Other', type: null, source: 'anchor' },
    ])
  })

  test('a meta refresh says where the page sends, when that is another page', () => {
    const page = (content: string, equiv = 'refresh') =>
      `<html><head><meta http-equiv="${equiv}" content="${content}"></head></html>`
    const base = 'https://byvoid.com/'
    // Hugo's multilingual root, as byvoid.com serves it.
    expect(findMetaRefresh(page('0; url=https://byvoid.com/zht/'), base)).toBe(
      'https://byvoid.com/zht/',
    )
    expect(findMetaRefresh(page("0;URL='/zht/'"), base)).toBe('https://byvoid.com/zht/')
    expect(findMetaRefresh(page('3, url = zht/'), base)).toBe('https://byvoid.com/zht/')
    expect(findMetaRefresh(page('0; /zht/'), base)).toBe('https://byvoid.com/zht/')
    expect(findMetaRefresh(page('0; url=/zht/', 'Refresh'), base)).toBe('https://byvoid.com/zht/')
    // A reload, the page itself, a script, or no refresh at all sends nowhere.
    expect(findMetaRefresh(page('300'), base)).toBeNull()
    expect(findMetaRefresh(page('0; url=/'), base)).toBeNull()
    expect(findMetaRefresh(page('0; url=/#top'), base)).toBeNull()
    expect(findMetaRefresh(page('0; url=javascript:alert(1)'), base)).toBeNull()
    expect(findMetaRefresh(page('0; url=/zht/', 'content-type'), base)).toBeNull()
  })

  test('candidate paths are absolute on the origin', () => {
    const urls = candidateFeedUrls('https://blog.example')
    expect(urls[0]).toBe('https://blog.example/feed')
    expect(urls).toContain('https://blog.example/index.xml')
  })
})

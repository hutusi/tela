import { describe, expect, test } from 'bun:test'
import { BLOG_RULES, type BlogRules, isSharedHost, sameBlog, siteKeyOf } from './blogs'

const rules: BlogRules = {
  sharedHosts: ['world.hey.com'],
  pathBlogs: ['https://lab.example/research', 'https://lab.example/research/notes'],
}

describe('a blog is an origin (ADR 0069)', () => {
  test('anywhere the rules do not name', () => {
    expect(siteKeyOf('https://Blog.Example/2026/10/post?x=1#y', rules)).toBe('https://blog.example')
    expect(siteKeyOf('http://blog.example:8080/feed', rules)).toBe('http://blog.example:8080')
    expect(siteKeyOf('https://www.blog.example/', rules)).toBe('https://www.blog.example')
    expect(siteKeyOf('ftp://blog.example/', rules)).toBe(null)
    expect(siteKeyOf('not a url', rules)).toBe(null)
  })

  test('on a shared host, by its first path segment', () => {
    expect(siteKeyOf('https://world.hey.com/dhh/feed.atom', rules)).toBe(
      'https://world.hey.com/dhh',
    )
    expect(siteKeyOf('https://world.hey.com/DHH/', rules)).toBe('https://world.hey.com/dhh')
    expect(siteKeyOf('https://www.world.hey.com/jason', rules)).toBe(
      'https://www.world.hey.com/jason',
    )
    // The host's own pages are the host's.
    expect(siteKeyOf('https://world.hey.com/', rules)).toBe('https://world.hey.com')
  })

  test('in a named section, the deepest, by whole segments', () => {
    expect(siteKeyOf('https://lab.example/research', rules)).toBe('https://lab.example/research')
    expect(siteKeyOf('http://www.lab.example/Research/proteins', rules)).toBe(
      'https://lab.example/research',
    )
    expect(siteKeyOf('https://lab.example/research/notes/1', rules)).toBe(
      'https://lab.example/research/notes',
    )
    expect(siteKeyOf('https://lab.example/researchers', rules)).toBe('https://lab.example')
    expect(siteKeyOf('https://lab.example/news/research', rules)).toBe('https://lab.example')
    expect(siteKeyOf('https://lab.example:8443/research', rules)).toBe('https://lab.example:8443')
  })

  test("Tela's own rules: each section is its own key, each shared host splits", () => {
    for (const key of BLOG_RULES.pathBlogs) expect(siteKeyOf(key)).toBe(key)
    for (const host of BLOG_RULES.sharedHosts) {
      expect(siteKeyOf(`https://${host}/someone/rss`)).toBe(`https://${host}/someone`)
    }
    expect(siteKeyOf('https://raw.githubusercontent.com/Olshansk/rss-feeds/main/x.xml')).toBe(
      'https://raw.githubusercontent.com',
    )
  })

  test('a shared host is known by its key, and two keys compare as one blog', () => {
    expect(isSharedHost('https://world.hey.com/dhh', rules)).toBe(true)
    expect(isSharedHost('https://lab.example/research', rules)).toBe(false)
    expect(sameBlog('https://world.hey.com/dhh', 'http://www.world.hey.com/DHH/')).toBe(true)
    expect(sameBlog('https://world.hey.com/dhh', 'https://world.hey.com/jason')).toBe(false)
    expect(sameBlog('https://blog.example', 'https://blog.example/')).toBe(true)
  })
})

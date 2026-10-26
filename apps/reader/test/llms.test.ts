/** `/llms.txt` (ADR 0060): what Tela is, its pages in each language, its feeds, how to cite. */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { memoryBlobs } from '@tela/platform/portable'
import { createEdge, type PublicPages } from '../worker/edge'
import { llmsTxt } from '../worker/llms'

const ORIGIN = 'https://telaread.com'
const TEXT = llmsTxt(ORIGIN)
const links = [...TEXT.matchAll(/\[([^\]]+)\]\(([^)]+)\)/g)].map((m) => ({
  name: m[1] as string,
  href: m[2] as string,
}))

describe('llms.txt', () => {
  test("is llmstxt.org's shape: a title, a summary, then sections of links", () => {
    const lines = TEXT.split('\n')
    expect(lines[0]).toBe('# Tela')
    expect(lines[2]).toMatch(/^> Tela is a reader and gathering place for independent blogs/)
    expect(lines.filter((l) => l.startsWith('## '))).toEqual([
      '## Key pages',
      '## In other languages',
      '## Feeds and lists',
      '## How to cite',
      '## Optional',
    ])
  })

  test("names Tela's key pages, each at Tela's own address", () => {
    const hrefs = links.map((l) => l.href)
    for (const path of [
      '/',
      '/discover',
      '/discover/articles',
      '/discover/blogs',
      '/discover/blogrolls',
      '/discover/readers',
      '/writers',
      '/about',
      '/privacy',
      '/terms',
      '/discover/articles.rss',
      '/discover.opml',
      '/sitemap.xml',
      '/robots.txt',
    ]) {
      expect(hrefs).toContain(`${ORIGIN}${path}`)
    }
    for (const { href } of links) expect(href.startsWith(`${ORIGIN}/`)).toBe(true)
  })

  test('names each language’s pages by their own names, at their ?hl= addresses', () => {
    expect(links).toContainEqual({ name: 'À propos', href: `${ORIGIN}/about?hl=fr` })
    expect(links).toContainEqual({ name: '发现', href: `${ORIGIN}/discover?hl=zh-Hans` })
    expect(links).toContainEqual({ name: '寫作者', href: `${ORIGIN}/writers?hl=zh-Hant` })
    expect(TEXT).toContain('- Français (`?hl=fr`): ')
  })

  test('says to cite the original post, and that Tela shows no full text', () => {
    expect(TEXT).toContain('Cite the original post')
    expect(TEXT).toContain("never show a post's full text")
  })

  test('is what the edge answers, run first by name', async () => {
    const edge = createEdge({
      blobs: memoryBlobs(),
      api: { fetch: async () => new Response('no', { status: 503 }) },
      assets: { fetch: async () => new Response('') },
      pages: {} as PublicPages,
      cache: { match: async () => undefined, put: async () => {} },
      fetchImage: async () => new Response('', { status: 404 }),
      config: { authSecret: 'a-test-secret-that-is-long-enough-for-hmac', noindex: false },
    })
    const res = await edge.fetch(new Request(`${ORIGIN}/llms.txt`))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8')
    expect(res.headers.get('cache-control')).toBe('public, max-age=3600')
    expect(res.headers.get('x-robots-tag')).toBeNull()
    expect(await res.text()).toBe(TEXT)
    const config = readFileSync(join(import.meta.dir, '..', 'wrangler.jsonc'), 'utf8')
    expect(config).toContain('"/llms.txt"')
  })
})

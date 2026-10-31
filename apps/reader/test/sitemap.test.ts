/**
 * Sitemaps (ADR 0060): an index of Tela's own pages and tela-api's lists, each page at its five
 * addresses with all five as alternates, well-formed XML within a sitemap's limits.
 */
import { beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { bumpSeq, currentSeq } from '@tela/data'
import { memoryBlobs } from '@tela/platform/portable'
import { TOPICS } from '@tela/shared'
import { sql } from 'drizzle-orm'
import { createTestApi, type TestApi } from '../../api/test/helpers'
import { requestLocale } from '../src/i18n'
import { type PublicRoute, publicRoute, renderPublicPage } from '../src/ssr'
import { createEdge, type EdgeCache, type PublicPages } from '../worker/edge'
import { kindPages, SITEMAP_PATHS, sitemapIndex, sitemapPage, urlset } from '../worker/sitemap'

const ORIGIN = 'https://telaread.com'

/**
 * Well-formed XML, as far as these files go: one root, every tag closed in order, attributes
 * quoted, and no `&` or `<` in text or values that is not markup or an entity.
 */
function wellFormed(text: string): { root: string; tags: string[] } {
  const body = text.replace(/^<\?xml version="1\.0" encoding="UTF-8"\?>\n/, '')
  const stack: string[] = []
  const tags: string[] = []
  let root = ''
  const token = /<(\/?)([A-Za-z][\w:.-]*)((?:\s+[\w:.-]+="[^"<]*")*)\s*(\/?)>|([^<]+)/gy
  let at = 0
  while (at < body.length) {
    token.lastIndex = at
    const m = token.exec(body)
    if (!m) throw new Error(`not XML at ${at}: ${body.slice(at, at + 40)}`)
    at = token.lastIndex
    const [, closing, name, attrs, selfClosing, chars] = m
    const checkEntities = (s: string) => {
      if (/&(?!(amp|lt|gt|quot|apos);)/.test(s)) throw new Error(`a bare & in ${s}`)
    }
    if (chars !== undefined) {
      if (stack.length === 0 && chars.trim()) throw new Error('text outside the root')
      checkEntities(chars)
      continue
    }
    checkEntities(attrs ?? '')
    if (closing) {
      if (stack.pop() !== name) throw new Error(`</${name}> closes nothing open`)
      continue
    }
    if (stack.length === 0) {
      if (root) throw new Error('two roots')
      root = name as string
    }
    tags.push(name as string)
    if (!selfClosing) stack.push(name as string)
  }
  if (stack.length) throw new Error(`unclosed: ${stack.join(' ')}`)
  return { root, tags }
}

const locs = (xml: string) =>
  [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]?.replaceAll('&amp;', '&'))

describe('the sitemap files', () => {
  test('list each page at its five addresses, each naming all five', () => {
    const xml = urlset(ORIGIN, [
      { path: '/discover/blogs?topic=tech', lastmod: Date.UTC(2026, 9, 1) },
    ])
    const { root, tags } = wellFormed(xml)
    expect(root).toBe('urlset')
    expect(xml).toContain('xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"')
    expect(xml).toContain('xmlns:xhtml="http://www.w3.org/1999/xhtml"')
    expect(locs(xml)).toEqual([
      `${ORIGIN}/discover/blogs?topic=tech`,
      `${ORIGIN}/discover/blogs?topic=tech&hl=zh-Hans`,
      `${ORIGIN}/discover/blogs?topic=tech&hl=zh-Hant`,
      `${ORIGIN}/discover/blogs?topic=tech&hl=en`,
      `${ORIGIN}/discover/blogs?topic=tech&hl=fr`,
    ])
    expect(tags.filter((t) => t === 'xhtml:link')).toHaveLength(25)
    const first = xml.match(/<url>.*?<\/url>/)?.[0] ?? ''
    expect(first).toContain('<lastmod>2026-10-01</lastmod>')
    expect(first).toContain(
      `<xhtml:link rel="alternate" hreflang="x-default" href="${ORIGIN}/discover/blogs?topic=tech"/>`,
    )
    expect(first).toContain(
      `<xhtml:link rel="alternate" hreflang="zh-Hant" href="${ORIGIN}/discover/blogs?topic=tech&amp;hl=zh-Hant"/>`,
    )
  })

  test("an index names Tela's own pages, then each kind's files, paged", () => {
    const xml = sitemapIndex(ORIGIN, {
      pageSize: 2,
      sites: { count: 3, lastmod: Date.UTC(2026, 9, 20) },
      blogrolls: { count: 0, lastmod: null },
      profiles: { count: 1, lastmod: null },
    })
    expect(wellFormed(xml).root).toBe('sitemapindex')
    expect(locs(xml)).toEqual([
      `${ORIGIN}/sitemap-pages.xml`,
      `${ORIGIN}/sitemap-sites.xml`,
      `${ORIGIN}/sitemap-sites.xml?page=2`,
      `${ORIGIN}/sitemap-profiles.xml`,
    ])
    expect(xml).toContain('<lastmod>2026-10-20</lastmod>')
  })

  test("a kind's file takes only what its page's address can be", () => {
    expect(
      kindPages('profiles', {
        items: [
          { handle: 'ann', lastmod: 5 },
          { handle: '../x', lastmod: 5 },
        ],
      }),
    ).toEqual([{ path: '/@ann', lastmod: 5 }])
    expect(
      kindPages('sites', {
        items: [
          { id: 3, lastmod: null },
          { id: 'x', lastmod: null },
        ],
      }),
    ).toEqual([{ path: '/s/3', lastmod: null }])
    expect(sitemapPage(null)).toBe(1)
    expect(sitemapPage('2')).toBe(2)
    for (const bad of ['0', '-1', '1.5', '02', 'x', '1001']) expect(sitemapPage(bad)).toBeNull()
  })

  test('stays inside a file’s limits at a full page of tela-api’s list', () => {
    const pages = Array.from({ length: 2000 }, (_, i) => ({
      path: `/@reader_${String(i).padStart(4, '0')}_long_handle`,
      lastmod: Date.UTC(2026, 9, 1),
    }))
    const xml = urlset(ORIGIN, pages)
    expect(locs(xml)).toHaveLength(10_000)
    expect(new TextEncoder().encode(xml).length).toBeLessThan(50 * 1024 * 1024)
  })

  test('every sitemap runs the Worker first, each by name', () => {
    const config = JSON.parse(
      readFileSync(join(import.meta.dir, '..', 'wrangler.jsonc'), 'utf8')
        .split('\n')
        .filter((line) => !line.trim().startsWith('//'))
        .join('\n'),
    ) as { assets: { run_worker_first: string[] } }
    for (const path of SITEMAP_PATHS) expect(config.assets.run_worker_first).toContain(path)
    expect(config.assets.run_worker_first.filter((p) => p.includes('sitemap'))).toEqual(
      SITEMAP_PATHS,
    )
  })
})

describe('the sitemaps at the edge', () => {
  let api: TestApi
  let edge: ReturnType<typeof createEdge>
  let asked: string[]
  let down: boolean

  const pages: PublicPages<PublicRoute> = {
    route: publicRoute,
    locale: requestLocale,
    render: ({ route, url, data, locale, template }) =>
      renderPublicPage({ route, url, data, locale: locale as never, now: 0, template }),
  }

  function memoryCache(): EdgeCache {
    const store = new Map<string, { body: ArrayBuffer; init: ResponseInit }>()
    return {
      async match(key) {
        const hit = store.get(key.url)
        return hit ? new Response(hit.body.slice(0), hit.init) : undefined
      },
      async put(key, response) {
        store.set(key.url, {
          body: await response.arrayBuffer(),
          init: { status: response.status, headers: response.headers },
        })
      },
    }
  }

  beforeEach(async () => {
    api = await createTestApi()
    asked = []
    down = false
    edge = createEdge({
      blobs: memoryBlobs(),
      api: {
        fetch: async (req) => {
          asked.push(new URL(req.url).pathname + new URL(req.url).search)
          return down ? new Response('down', { status: 503 }) : api.app.fetch(req)
        },
      },
      assets: { fetch: async () => new Response('<html lang="en"></html>') },
      pages: pages as unknown as PublicPages,
      cache: memoryCache(),
      fetchImage: async () => new Response('', { status: 404 }),
      config: { authSecret: 'a-test-secret-that-is-long-enough-for-hmac', noindex: false },
    })
    const db = api.db
    await db.batch([
      bumpSeq(db),
      db.run(sql`insert into sites (id, home_url, title, listing, review, created_at, updated_at, seq)
        values (1, 'https://one.example', 'One', 'listed', 'listed', 0, ${Date.UTC(2026, 9, 2)}, ${currentSeq})`),
      db.run(sql`insert into sites (id, home_url, title, listing, review, created_at, updated_at, seq)
        values (2, 'https://two.example', 'Two', 'listed', null, 0, 0, ${currentSeq})`),
    ] as never)
  })

  const get = (path: string) => edge.fetch(new Request(`${ORIGIN}${path}`))

  test('the index, from tela-api through the colo, an hour', async () => {
    const res = await get('/sitemap.xml')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/xml; charset=utf-8')
    expect(res.headers.get('cache-control')).toBe('public, max-age=3600')
    expect(res.headers.get('x-robots-tag')).toBe('noindex')
    const xml = await res.text()
    expect(locs(xml)).toEqual([`${ORIGIN}/sitemap-pages.xml`, `${ORIGIN}/sitemap-sites.xml`])
    await get('/sitemap.xml')
    expect(asked).toEqual(['/api/v1/public/sitemap'])
  })

  test("Tela's own pages need nothing of tela-api", async () => {
    const xml = await (await get('/sitemap-pages.xml')).text()
    wellFormed(xml)
    const bare = locs(xml).filter((l) => !l?.includes('hl='))
    expect(bare).toEqual([
      `${ORIGIN}/`,
      `${ORIGIN}/discover`,
      `${ORIGIN}/discover/articles`,
      `${ORIGIN}/discover/blogs`,
      `${ORIGIN}/discover/blogrolls`,
      `${ORIGIN}/discover/readers`,
      ...TOPICS.map((t) => `${ORIGIN}/discover/blogs?topic=${t}`),
      `${ORIGIN}/about`,
      `${ORIGIN}/privacy`,
      `${ORIGIN}/terms`,
      `${ORIGIN}/writers`,
      `${ORIGIN}/bot`,
    ])
    expect(asked).toEqual([])
  })

  test('the blogs an operator listed, and no other', async () => {
    const xml = await (await get('/sitemap-sites.xml')).text()
    wellFormed(xml)
    expect(locs(xml).filter((l) => !l?.includes('hl='))).toEqual([`${ORIGIN}/s/1`])
    expect(xml).toContain('<lastmod>2026-10-02</lastmod>')
    expect((await get('/sitemap-sites.xml?page=x')).status).toBe(404)
    expect(await (await get('/sitemap-sites.xml?page=2')).text()).not.toContain('<url>')
  })

  test('no list from tela-api is a 503 to ask again after, never an empty sitemap', async () => {
    down = true
    for (const path of ['/sitemap.xml', '/sitemap-profiles.xml']) {
      const res = await get(path)
      expect(res.status).toBe(503)
      expect(res.headers.get('retry-after')).toBe('3600')
      expect(res.headers.get('cache-control')).toBe('no-store')
    }
  })
})

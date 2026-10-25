import { beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { parseFeedText } from '@tela/content'
import { feedsFromOpml } from '@tela/content/opml'
import { bumpSeq, currentSeq } from '@tela/data'
import type { Blobs } from '@tela/platform'
import { memoryBlobs } from '@tela/platform/portable'
import type { UiLocale } from '@tela/shared'
import { sql } from 'drizzle-orm'
import { XMLValidator } from 'fast-xml-parser'
import { createTestApi, signedIn, type TestApi } from '../../api/test/helpers'
import { requestLocale } from '../src/i18n'
import { type PublicRoute, publicRoute, renderPublicPage } from '../src/ssr'
import type {
  ArticlesData,
  BlogrollCard,
  BlogrollData,
  BlogrollsData,
  DiscoverPost,
  FrontData,
  ProfileData,
  ReaderCandidate,
  ReadersData,
  WeekData,
} from '../src/views/types'
import { createEdge, type EdgeCache, type PublicPages } from '../worker/edge'
import { SECURITY_HEADERS } from '../worker/security'

const KEY = 'a'.repeat(32)
const OTHER = 'b'.repeat(32)
const ORIGIN = 'http://tela.test'

let api: TestApi
let blobs: ReturnType<typeof memoryBlobs>
let gets: string[]
let images: { url: string; response: () => Response }[]
let fetched: string[]
let cookie: string
/** What the member's client names itself with on a member call (protocol and member id). */
let client: Record<string, string>

function memoryCache(): EdgeCache & { size: number } {
  const store = new Map<string, { body: ArrayBuffer; init: ResponseInit }>()
  return {
    get size() {
      return store.size
    },
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

let cache: ReturnType<typeof memoryCache>
let edge: ReturnType<typeof createEdge>
/** What reached tela-api, by path. */
let apiCalls: string[]
/** The cookie each call to tela-api carried, if any. */
let apiCookies: (string | null)[]
/** The edge's clock, for the age of a colo copy. */
let edgeNow: number

/** The SPA's index.html as Vite builds it, and as the edge fills it. */
const TEMPLATE = `<!doctype html>
<html lang="en">
  <head>
    <title>Tela</title>
    <meta name="description" content="Independent blogs, in any language." />
    <meta name="robots" content="noindex, nofollow" />
    <script type="module" crossorigin src="/assets/index-abc123.js"></script>
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>`

const pages: PublicPages<PublicRoute> = {
  route: publicRoute,
  locale: requestLocale,
  render: ({ route, url, data, locale, template }) =>
    renderPublicPage({ route, url, data, locale: locale as UiLocale, now: 0, template }),
}

beforeEach(async () => {
  api = await createTestApi()
  blobs = memoryBlobs()
  gets = []
  const counted: Blobs = {
    ...blobs,
    get: (k) => {
      gets.push(k)
      return blobs.get(k)
    },
  }
  images = []
  fetched = []
  apiCalls = []
  apiCookies = []
  edgeNow = Date.UTC(2026, 9, 19, 12)
  cache = memoryCache()
  edge = createEdge({
    blobs: counted,
    api: {
      fetch: async (req) => {
        apiCalls.push(new URL(req.url).pathname)
        apiCookies.push(req.headers.get('cookie'))
        return api.app.fetch(req)
      },
    },
    now: () => edgeNow,
    assets: {
      fetch: async () => new Response(TEMPLATE, { headers: { 'content-type': 'text/html' } }),
    },
    pages: pages as unknown as PublicPages,
    cache,
    fetchImage: async (url) => {
      fetched.push(url)
      const found = images.find((i) => i.url === url)
      return found ? found.response() : new Response('nope', { status: 404 })
    },
    config: { authSecret: 'a-test-secret-that-is-long-enough-for-hmac', noindex: true },
  })
  const reader = await signedIn(api)
  cookie = reader.cookie
  client = reader.headers
  await blobs.put(
    `c/${KEY}.json`,
    JSON.stringify({
      key: KEY,
      blocks: [],
      images: ['https://img.example/a.png', 'https://img.example/b.svg', 'http://127.0.0.1/x.png'],
    }),
  )
})

const get = (path: string, withCookie: string | null = cookie) =>
  edge.fetch(new Request(`${ORIGIN}${path}`, withCookie ? { headers: { cookie: withCookie } } : {}))

describe('content objects', () => {
  test('need a session, then come immutable and private, and from the cache after the first read', async () => {
    expect((await get(`/o/c/${KEY}.json`, null)).status).toBe(401)
    const res = await get(`/o/c/${KEY}.json`)
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('private, max-age=31536000, immutable')
    expect(res.headers.get('x-robots-tag')).toBe('noindex')
    expect(((await res.json()) as { key: string }).key).toBe(KEY)
    await get(`/o/c/${KEY}.json`)
    expect(gets.filter((g) => g === `c/${KEY}.json`)).toHaveLength(1)
  })

  test('only content, translation and chunk objects are served; raw HTML never', async () => {
    await blobs.put('r/abc.html', '<p>raw</p>')
    expect((await get('/o/r/abc.html')).status).toBe(404)
    expect((await get('/o/c/../r/abc.html')).status).toBe(404)
    expect((await get(`/o/c/${OTHER}.json`)).status).toBe(404) // allowed shape, missing object
  })

  test('a key that does not decode is not found, not an error', async () => {
    for (const path of ['/o/%', '/o/c/%E4.json', `/o/c/${KEY}%.json`]) {
      expect((await get(path)).status).toBe(404)
      expect((await get(path, null)).status).toBe(404)
    }
    expect(gets).toEqual([])
  })

  test('a bundle carries the objects that exist, keyed, capped at 25', async () => {
    const res = await get(`/o/bundle?k=${KEY},${OTHER},nothex,${KEY}`)
    expect(Object.keys((await res.json()) as object)).toEqual([KEY])
    expect((await get(`/o/bundle?k=${KEY}`, null)).status).toBe(401)
  })

  test('a lapsed session cache is renewed through tela-api, and the fresh cookie passed on', async () => {
    const tokenOnly = cookie
      .split('; ')
      .filter((c) => c.startsWith('tela.session_token='))
      .join('; ')
    const res = await get(`/o/c/${KEY}.json`, tokenOnly)
    expect(res.status).toBe(200)
    expect(res.headers.getSetCookie().some((c) => c.startsWith('tela.session_data='))).toBe(true)
  })

  test('a forged session cache is not trusted', async () => {
    expect((await get(`/o/c/${KEY}.json`, 'tela.session_data=eyJmb3JnZWQiOnRydWV9')).status).toBe(
      401,
    )
  })
})

describe('the image proxy', () => {
  test('fetches the image the object names, once, with the rules ADR 0007 set', async () => {
    images.push({
      url: 'https://img.example/a.png',
      response: () =>
        new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } }),
    })
    const res = await get(`/img/${KEY}/0`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox")
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]))
    await get(`/img/${KEY}/0`)
    expect(fetched).toEqual(['https://img.example/a.png'])
  })

  test('refuses SVG, private hosts, indexes the object does not name, and strangers', async () => {
    images.push({
      url: 'https://img.example/b.svg',
      response: () => new Response('<svg/>', { headers: { 'content-type': 'image/svg+xml' } }),
    })
    expect((await get(`/img/${KEY}/1`)).status).toBe(415)
    expect((await get(`/img/${KEY}/2`)).status).toBe(403)
    expect((await get(`/img/${KEY}/9`)).status).toBe(404)
    expect((await get(`/img/${KEY}/0`, null)).status).toBe(401)
    expect(fetched).toEqual(['https://img.example/b.svg'])
  })

  test('stops reading an image past 10 MB', async () => {
    images.push({
      url: 'https://img.example/a.png',
      response: () =>
        new Response(new Uint8Array(10 * 1024 * 1024 + 1), {
          headers: { 'content-type': 'image/png' },
        }),
    })
    expect((await get(`/img/${KEY}/0`)).status).toBe(413)
  })

  test('an image whose body breaks off is a 502, and nothing is kept', async () => {
    images.push({
      url: 'https://img.example/a.png',
      response: () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))
              controller.error(new Error('connection reset'))
            },
          }),
          { headers: { 'content-type': 'image/png' } },
        ),
    })
    const first = await get(`/img/${KEY}/0`)
    expect(first.status).toBe(502)
    // Kept as a failure for ten minutes, never as an image: the host is not asked again meanwhile.
    expect(first.headers.get('cache-control')).toBe('private, max-age=600')
    const again = await get(`/img/${KEY}/0`)
    expect(again.status).toBe(502)
    expect(again.headers.get('cache-control')).toBe('private, max-age=600')
    expect(fetched).toEqual(['https://img.example/a.png'])
  })

  test('every failure is kept ten minutes at the colo, and an image a week, both public there', async () => {
    images.push({
      url: 'https://img.example/a.png',
      response: () => new Response('gone', { status: 404 }),
    })
    const stored: Record<string, string | null> = {}
    const put = cache.put.bind(cache)
    cache.put = async (key, response) => {
      stored[new URL(key.url).pathname] = response.headers.get('cache-control')
      return put(key, response)
    }
    expect((await get(`/img/${KEY}/0`)).status).toBe(502) // the host's 404
    expect((await get(`/img/${KEY}/2`)).status).toBe(403) // a private host
    expect((await get(`/img/${KEY}/9`)).status).toBe(404) // no such image
    expect(stored).toMatchObject({
      [`/img/${KEY}/0`]: 'public, max-age=600',
      [`/img/${KEY}/2`]: 'public, max-age=600',
      [`/img/${KEY}/9`]: 'public, max-age=600',
    })
    for (const i of [0, 2, 9]) await get(`/img/${KEY}/${i}`)
    expect(fetched).toEqual(['https://img.example/a.png'])

    images.length = 0
    images.push({
      url: 'https://img.example/c.png',
      response: () =>
        new Response(new Uint8Array([1]), { headers: { 'content-type': 'image/png' } }),
    })
    await blobs.put(
      `c/${OTHER}.json`,
      JSON.stringify({ key: OTHER, blocks: [], images: ['https://img.example/c.png'] }),
    )
    const image = await get(`/img/${OTHER}/0`)
    expect(image.headers.get('cache-control')).toBe('private, max-age=604800, immutable')
    expect(stored[`/img/${OTHER}/0`]).toBe('public, max-age=604800, immutable')
    // From the colo, the browser is told what it always was.
    const hit = await get(`/img/${OTHER}/0`)
    expect(hit.headers.get('cache-control')).toBe('private, max-age=604800, immutable')
    expect(fetched.filter((u) => u.endsWith('c.png'))).toHaveLength(1)
  })
})

describe("members' pictures (ADR 0032)", () => {
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])
  /** An edge whose tela-api answers pictures as `answer` says, counting what it was asked. */
  function pictures(answer: () => Response) {
    const asked: string[] = []
    const local = memoryCache()
    const pictureEdge = createEdge({
      blobs,
      api: {
        fetch: async (req) => {
          const url = new URL(req.url)
          asked.push(url.pathname + url.search)
          return answer()
        },
      },
      assets: { fetch: async () => new Response(TEMPLATE) },
      pages: pages as unknown as PublicPages,
      cache: local,
      fetchImage: async () => new Response('nope', { status: 404 }),
      config: { authSecret: 'a-test-secret-that-is-long-enough-for-hmac', noindex: true },
    })
    const fetchPath = (path: string) => pictureEdge.fetch(new Request(`${ORIGIN}${path}`))
    return { asked, fetchPath }
  }
  const image = () =>
    new Response(PNG, {
      headers: {
        'content-type': 'image/png',
        'cache-control': 'public, max-age=2592000, immutable',
      },
    })

  test('come from tela-api once a version, then from the colo, to anyone', async () => {
    const { asked, fetchPath } = pictures(image)
    const first = await fetchPath('/avatar/member-anna-0001?v=5')
    expect(first.status).toBe(200)
    expect(first.headers.get('content-type')).toBe('image/png')
    expect(first.headers.get('cache-control')).toBe('public, max-age=2592000, immutable')
    expect(new Uint8Array(await first.arrayBuffer())).toEqual(PNG)
    const again = await fetchPath('/avatar/member-anna-0001?v=5')
    expect(new Uint8Array(await again.arrayBuffer())).toEqual(PNG)
    await fetchPath('/avatar/member-anna-0001?v=6') // Refresh: a new address
    expect(asked).toEqual([
      '/api/v1/public/avatars/member-anna-0001?v=5',
      '/api/v1/public/avatars/member-anna-0001?v=6',
    ])
  })

  test('none is cached as tela-api says; a failure is not cached at all', async () => {
    const none = pictures(
      () =>
        new Response('no picture', {
          status: 404,
          headers: { 'cache-control': 'public, max-age=300' },
        }),
    )
    expect((await none.fetchPath('/avatar/member-anna-0001?v=5')).status).toBe(404)
    expect((await none.fetchPath('/avatar/member-anna-0001?v=5')).status).toBe(404)
    expect(none.asked).toHaveLength(1)
    const down = pictures(() => new Response('down', { status: 503 }))
    const res = await down.fetchPath('/avatar/member-anna-0001?v=5')
    expect(res.status).toBe(502)
    expect(res.headers.get('cache-control')).toBe('no-store')
    await down.fetchPath('/avatar/member-anna-0001?v=5')
    expect(down.asked).toHaveLength(2)
    // A body that breaks off after its headers: the same 502, and nothing kept.
    const cut = pictures(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(PNG)
              controller.error(new Error('connection reset'))
            },
          }),
          { headers: { 'content-type': 'image/png' } },
        ),
    )
    const broken = await cut.fetchPath('/avatar/member-anna-0001?v=5')
    expect(broken.status).toBe(502)
    expect(broken.headers.get('cache-control')).toBe('no-store')
    await cut.fetchPath('/avatar/member-anna-0001?v=5')
    expect(cut.asked).toHaveLength(2)
  })

  test('an address that names no member or version asks tela-api nothing', async () => {
    const { asked, fetchPath } = pictures(image)
    for (const path of [
      '/avatar/x?v=1',
      '/avatar/member-anna-0001?v=abc',
      '/avatar/member-anna-0001',
    ])
      expect([path, (await fetchPath(path)).status]).toEqual([path, 404])
    expect(asked).toEqual([])
  })
})

describe('everything else', () => {
  test('/api goes to tela-api', async () => {
    const res = await get('/api/health', null)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true })
  })

  test('in private beta nothing is indexed', async () => {
    expect(await (await get('/robots.txt', null)).text()).toBe('User-agent: *\nDisallow: /\n')
    expect((await get('/api/health', null)).headers.get('x-robots-tag')).toBe('noindex, nofollow')
  })
})

describe('security headers (ADR 0051)', () => {
  const has = (res: Response) =>
    Object.entries(SECURITY_HEADERS).every(([name, value]) => res.headers.get(name) === value)

  test('every page the Worker answers carries them, from the cache too', async () => {
    await listedBlog(1, 'Garden Notes')
    const visit = (path: string, headers: Record<string, string> = {}) =>
      edge.fetch(new Request(`${ORIGIN}${path}`, { headers }))
    expect(has(await visit('/discover/blogs'))).toBe(true) // rendered
    expect(has(await visit('/discover/blogs'))).toBe(true) // the colo's copy
    expect(has(await visit('/about'))).toBe(true) // no data at all
    expect(has(await visit('/', { cookie }))).toBe(true) // a member's plain shell
    expect(has(await visit('/s/999'))).toBe(true) // a 404 page
    // tela-api down: the plain shell.
    const down = createEdge({
      blobs,
      api: { fetch: async () => new Response('down', { status: 503 }) },
      assets: {
        fetch: async () => new Response(TEMPLATE, { headers: { 'content-type': 'text/html' } }),
      },
      pages: pages as unknown as PublicPages,
      cache: memoryCache(),
      fetchImage: async () => new Response('nope', { status: 404 }),
      config: { authSecret: 'a-test-secret-that-is-long-enough-for-hmac', noindex: true },
    })
    expect(has(await down.fetch(new Request(`${ORIGIN}/discover/blogs`)))).toBe(true)
  })

  test('what is no page does without them', async () => {
    const json = await get('/api/health', null)
    expect(json.headers.get('content-security-policy-report-only')).toBeNull()
    expect((await get(`/o/c/${KEY}.json`)).headers.get('x-frame-options')).toBeNull()
  })
})

describe('public JSON at the colo', () => {
  const ask = (path: string, headers: Record<string, string> = {}) =>
    edge.fetch(new Request(`${ORIGIN}${path}`, { headers: { cookie, ...headers } }))
  const titles = async (res: Response) =>
    ((await res.json()) as { sites: { title: string }[] }).sites.map((s) => s.title)

  test("the app's own request goes to tela-api every time, cookie and all", async () => {
    await listedBlog(1, 'Garden Notes')
    expect(await titles(await ask('/api/v1/public/discover'))).toEqual(['Garden Notes'])
    await listedBlog(2, 'Harbour Log')
    // A member who just claimed or hid something sees it at once, not five minutes on.
    expect((await titles(await ask('/api/v1/public/discover'))).sort()).toEqual([
      'Garden Notes',
      'Harbour Log',
    ])
    expect(apiCalls).toEqual(['/api/v1/public/discover', '/api/v1/public/discover'])
    expect(apiCookies).toEqual([cookie, cookie])
  })

  test("a rendered page's four languages read tela-api once", async () => {
    await listedBlog(1, 'Garden Notes')
    const page = (headers: Record<string, string> = {}) =>
      edge.fetch(new Request(`${ORIGIN}/discover/blogs`, { headers }))
    expect((await page()).status).toBe(200)
    expect((await page({ cookie: 'tela_locale=fr' })).status).toBe(200)
    expect((await page({ cookie: 'tela_locale=zh-Hans' })).status).toBe(200)
    expect(apiCalls).toEqual(['/api/v1/public/discover'])
  })

  test('a page made from an older copy is kept only as long as the copy had left', async () => {
    await listedBlog(1, 'Garden Notes')
    const kept: Record<string, string | null> = {}
    const put = cache.put.bind(cache)
    cache.put = async (key, response) => {
      kept[new URL(key.url).pathname] = response.headers.get('cache-control')
      return put(key, response)
    }
    const page = (headers: Record<string, string> = {}) =>
      edge.fetch(new Request(`${ORIGIN}/discover/blogs`, { headers }))
    await page()
    expect(Object.entries(kept).find(([k]) => k.includes('/en/'))?.[1]).toBe('public, s-maxage=300')
    edgeNow += 240_000
    await page({ cookie: 'tela_locale=zh-Hans' })
    expect(Object.entries(kept).find(([k]) => k.includes('/zh-Hans/'))?.[1]).toBe(
      'public, s-maxage=60',
    )
    expect(apiCalls).toEqual(['/api/v1/public/discover'])
  })

  test('a member call is never kept, and keeps its cookie', async () => {
    await get('/api/v1/me')
    await get('/api/v1/me')
    expect(apiCalls).toEqual(['/api/v1/me', '/api/v1/me'])
    expect(apiCookies.every((c) => c === cookie)).toBe(true)
  })
})

/** A blog an operator listed, unless `review` says nobody has (a claimed blog, say). */
async function listedBlog(
  id: number,
  title: string,
  listing = 'listed',
  review: 'listed' | null = 'listed',
) {
  const db = api.db
  await db.batch([
    bumpSeq(db),
    db.run(sql`insert into sites (id, home_url, title, listing, review, primary_lang, created_at, updated_at, seq)
      values (${id}, ${`https://blog${id}.example`}, ${title}, ${listing}, ${review}, 'en', 0, 0, ${currentSeq})`),
    db.run(sql`insert into feeds (id, site_id, feed_url, host, next_fetch_at, created_at, updated_at, seq)
      values (${id}, ${id}, ${`https://blog${id}.example/feed`}, ${`blog${id}.example`}, 0, 0, 0, ${currentSeq})`),
  ] as never)
}

describe('public pages', () => {
  const page = (path: string, headers: Record<string, string> = {}) =>
    edge.fetch(new Request(`${ORIGIN}${path}`, { headers }))

  test('render into the SPA shell with their data handed over, and come from the cache after', async () => {
    await listedBlog(1, 'Garden Notes')
    const res = await page('/discover/blogs')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    expect(res.headers.get('cache-control')).toBe('public, max-age=0, must-revalidate')
    const html = await res.text()
    expect(html).toContain('<title>Blogs · Discover · Tela</title>')
    expect(html).toMatch(/<a[^>]*aria-current="page"[^>]*data-testid="discover-tab-blogs"/)
    expect(html).toMatch(/<div id="root">.*Garden Notes.*<\/div><script id="tela-data"/s)
    expect(html).toContain('/assets/index-abc123.js')
    // The shell's own noindex is for the app; a public page is indexed as the edge's header says.
    expect(html).not.toContain('name="robots"')
    const handed = JSON.parse(
      html.match(/<script id="tela-data" type="application\/json">(.*?)<\/script>/s)?.[1] ?? '',
    )
    // The Blogs page moved to `/discover/blogs`; its endpoint stayed where it was (ADR 0044).
    expect(handed.path).toBe('/api/v1/public/discover')
    expect(handed.body.sites[0].title).toBe('Garden Notes')

    await page('/discover/blogs?utm_source=x')
    expect(apiCalls.filter((p) => p.startsWith('/api/v1/public/'))).toEqual([
      '/api/v1/public/discover',
    ])
  })

  test('Discover past one page renders a pager, so the rest is reachable before any script', async () => {
    for (let id = 1; id <= 61; id++) await listedBlog(id, `Blog ${id}`)
    const pager = (html: string) => html.match(/data-testid="discover-pager".*?<\/nav>/s)?.[0] ?? ''
    const cards = (html: string) => (html.match(/data-testid="site-card"/g) ?? []).length

    const one = await (await page('/discover/blogs')).text()
    expect(cards(one)).toBe(60)
    expect(pager(one)).toContain('Page 1 of 2')
    expect(pager(one)).toContain('href="/discover/blogs?page=2"')
    expect(pager(one)).not.toContain('Previous')

    const two = await (await page('/discover/blogs?page=2')).text()
    expect(cards(two)).toBe(1)
    expect(two).toContain('Blog 61')
    expect(pager(two)).toContain('Page 2 of 2')
    expect(pager(two)).toContain('href="/discover/blogs"')
    expect(pager(two)).not.toContain('Next')
  })

  test("render in the reader's language, cached apart", async () => {
    await listedBlog(1, 'Garden Notes')
    const zh = await (await page('/discover/blogs', { cookie: 'tela_locale=zh-Hans' })).text()
    expect(zh).toContain('<html lang="zh-Hans"')
    expect(zh).toContain('<title>博客 · 发现 · Tela</title>')
    const en = await (await page('/discover/blogs')).text()
    expect(en).toContain('<html lang="en"')
    // Two pages, one answer: the JSON carries every language, and the colo keeps it once.
    expect(apiCalls.filter((p) => p.startsWith('/api/v1/public/'))).toHaveLength(1)
  })

  test("a profile's picture renders as Tela's address, never Gravatar's (ADR 0032)", async () => {
    const reader = await signedIn(api, 'pictured@x.test')
    await api.request('/api/v1/profile', {
      method: 'PUT',
      body: { handle: 'pictured' },
      as: reader,
    })
    // Gravatar has a picture for them, as the check found (ADR 0033).
    await api.db.run(sql`update profiles set gravatar_found = 1 where user_id = ${reader.userId}`)
    await api.request('/api/v1/mutations', {
      body: { mutations: [{ mid: 'gravatar-on-edge', at: 77, type: 'setAvatar', gravatar: true }] },
      as: reader,
    })
    const html = await (await page('/@pictured')).text()
    expect(html).toContain(`src="/avatar/${reader.userId}?v=1"`)
    expect(html).not.toContain('gravatar.com')
    expect(html).not.toContain('pictured@x.test')
  })

  test("a profile's tabs are pages of their own, cached apart", async () => {
    const reader = await signedIn(api, 'shown@x.test')
    await api.request('/api/v1/profile', {
      method: 'PUT',
      body: { handle: 'shown', displayName: 'Shown Reader' },
      as: reader,
    })
    await api.request('/api/v1/mutations', {
      body: {
        mutations: [{ mid: 'show-subs-000', at: 1, type: 'setPrivacy', publicSubscriptions: true }],
      },
      as: reader,
    })
    const recs = await (await page('/@shown')).text()
    expect(recs).toContain('data-testid="profile-recommendations"')
    const subs = await (await page('/@shown?tab=subscriptions')).text()
    expect(subs).toContain('data-testid="profile-subscriptions"')
    // A second visit to each is the cache's, and both tabs render from one answer.
    await page('/@shown')
    await page('/@shown?tab=subscriptions')
    expect(apiCalls.filter((p) => p.startsWith('/api/v1/public/profiles/'))).toHaveLength(1)
  })

  test("the previous release's public JSON still renders, without what it never said", () => {
    const render = (route: PublicRoute, data: unknown) =>
      renderPublicPage({
        route,
        url: new URL(`${ORIGIN}/x`),
        data,
        locale: 'en',
        now: 0,
        template: TEMPLATE,
      })
    // As main's tela-api answers: no counts, liked, notes, claimant, postsLast30d or account id.
    const profile = render(publicRoute(new URL(`${ORIGIN}/@old`)) as PublicRoute, {
      profile: { handle: 'old', displayName: 'Old Reader', bio: null, memberSince: 0 },
      blogs: [],
      recommendations: [],
      subscriptions: null,
    })
    expect(profile).toContain('Old Reader')
    // What it never counted is left out, not shown as nobody.
    expect(profile).not.toContain('data-testid="profile-counts"')
    const site = render(publicRoute(new URL(`${ORIGIN}/s/1`)) as PublicRoute, {
      site: {
        id: 1,
        title: 'Old Blog',
        homeUrl: 'https://old.example',
        description: null,
        faviconKey: null,
        primaryLang: 'en',
        listing: 'listed',
        readerCount: 3,
        claimedBy: 'old',
      },
      feeds: [],
      posts: [],
      topics: [],
    })
    expect(site).toContain('Old Blog')
    expect(site).toContain('data-testid="claimed-badge"')
  })

  test('a page this build cannot render is the plain shell as a 503, not an error', async () => {
    const throwing = createEdge({
      blobs,
      api: { fetch: async (req) => api.app.fetch(req) },
      assets: {
        fetch: async () => new Response(TEMPLATE, { headers: { 'content-type': 'text/html' } }),
      },
      pages: {
        ...pages,
        render: () => {
          throw new TypeError('cannot read properties of undefined')
        },
      } as unknown as PublicPages,
      cache,
      fetchImage: async () => new Response('nope', { status: 404 }),
      config: { authSecret: 'a-test-secret-that-is-long-enough-for-hmac', noindex: true },
    })
    await listedBlog(4, 'Unrenderable')
    const logged: unknown[][] = []
    const error = console.error
    console.error = (...args: unknown[]) => void logged.push(args)
    try {
      const res = await throwing.fetch(new Request(`${ORIGIN}/s/4`))
      expect(res.status).toBe(503)
      expect(res.headers.get('retry-after')).toBe('120')
      expect(res.headers.get('cache-control')).toBe('no-store')
      expect(await res.text()).toBe(TEMPLATE)
    } finally {
      console.error = error
    }
    expect(logged).toMatchObject([['public page did not render', '/s/4', expect.any(TypeError)]])
  })

  test('a blog that is not public is a 404 page, and a path that is no page is the plain shell', async () => {
    await listedBlog(2, 'Hidden', 'private')
    const hidden = await page('/s/2')
    expect(hidden.status).toBe(404)
    expect(await hidden.text()).toContain('data-testid="not-found"')
    const other = await page('/s/2/extra')
    expect(other.status).toBe(200)
    expect(await other.text()).toBe(TEMPLATE)
  })

  test('a profile address or a language cookie that does not decode is no page and no choice', async () => {
    const shell = await page('/@%')
    expect(shell.status).toBe(200)
    expect(await shell.text()).toBe(TEMPLATE)
    // The browser's language decides, as with no cookie at all.
    const zh = await page('/terms', { cookie: 'tela_locale=%', 'accept-language': 'zh-CN' })
    expect(zh.status).toBe(200)
    expect(await zh.text()).toContain('<html lang="zh-Hans"')
    const en = await page('/terms', { cookie: 'a=1; tela_locale=%E4' })
    expect(en.status).toBe(200)
    expect(await en.text()).toContain('<html lang="en"')
    expect(apiCalls).toEqual([])
  })

  test('About, Privacy and Terms ask tela-api nothing, hand nothing over, and are never indexed in the beta', async () => {
    for (const path of ['/about', '/privacy', '/terms']) {
      const res = await page(path)
      expect(res.status).toBe(200)
      expect(res.headers.get('x-robots-tag')).toBe('noindex, nofollow')
      expect(res.headers.get('cache-control')).toBe('public, max-age=0, must-revalidate')
      const html = await res.text()
      expect(html).toContain('data-testid="info-page"')
      // The front page's footer closes them too, its links whole without a script.
      expect(html).toContain('data-testid="site-footer"')
      expect(html).toContain('href="/terms"')
      expect(html).not.toContain('id="tela-data"')
      expect(html).not.toContain('name="robots"')
      expect(html).toContain('/assets/index-abc123.js')
    }
    const privacy = await (await page('/privacy')).text()
    expect(privacy).toContain('<title>Privacy · Tela</title>')
    expect(privacy).toMatch(/<meta name="description" content="Tela keeps what it needs/)
    expect(privacy).toContain('id="cookies"')
    expect(privacy).toContain('href="#cookies"')
    expect(privacy).toContain('Last updated 25 October 2026')
    expect(apiCalls).toEqual([])
    // Three pages, once each: the second visit to Privacy came from the cache.
    expect(cache.size).toBe(3)
  })

  test('carry the theme menu with all three glyphs, which the stylesheet chooses between', async () => {
    // One cached page for every visitor, whatever their theme: the HTML holds every glyph with its
    // name, the page's CSS shows the one `data-theme` says, and no item claims a choice (ADR 0037).
    const menu = (html: string) =>
      html.match(/<details[^>]*data-testid="theme-menu"[^>]*>.*?<\/details>/s)?.[0] ?? ''
    const en = menu(await (await page('/about')).text())
    for (const [theme, name] of [
      ['system', 'Auto'],
      ['light', 'Light'],
      ['dark', 'Dark'],
    ]) {
      expect(en).toMatch(
        new RegExp(
          `<span class="theme-is-${theme}"><svg.*?</svg><span class="sr-only">Theme: ${name}</span></span>`,
          's',
        ),
      )
      expect(en).toContain(`data-testid="theme-menu-${theme}"`)
    }
    expect(en).not.toContain('aria-pressed')
    const zh = menu(await (await page('/about', { cookie: 'tela_locale=zh-Hans' })).text())
    expect(zh).toContain('主题：跟随系统')
    expect(zh).toContain('主题：深色')
  })

  test("mark the visitor's language in the language circle, as the cache is kept per language", async () => {
    const menu = (html: string) =>
      html.match(/<details[^>]*data-testid="language-menu"[^>]*>.*?<\/details>/s)?.[0] ?? ''
    const summary = (html: string) => html.match(/<summary.*?<\/summary>/s)?.[0] ?? ''
    const en = menu(await (await page('/privacy')).text())
    // The circle shows the language the page is in, short, and names it in full, the name in its
    // own `lang` for a screen reader's voice; the list names each in its own script.
    expect(summary(en)).toMatch(
      /<span aria-hidden="true" lang="en">EN<\/span><span class="sr-only">Language: <span lang="en">English<\/span><\/span>/,
    )
    expect(en).toMatch(/<button[^>]*aria-pressed="true"[^>]*data-testid="language-menu-en"/)
    expect(en).toMatch(/<button[^>]*aria-pressed="false"[^>]*data-testid="language-menu-zh-Hans"/)
    expect(en).toMatch(/<button[^>]*lang="zh-Hans"[^>]*>简体中文<\/button>/)
    const zh = menu(await (await page('/privacy', { cookie: 'tela_locale=zh-Hans' })).text())
    expect(summary(zh)).toMatch(
      /<span aria-hidden="true" lang="zh-Hans">简<\/span><span class="sr-only">语言：<span lang="zh-Hans">简体中文<\/span><\/span>/,
    )
    expect(zh).toMatch(/<button[^>]*aria-pressed="true"[^>]*data-testid="language-menu-zh-Hans"/)
    const hant = menu(await (await page('/privacy', { cookie: 'tela_locale=zh-Hant' })).text())
    expect(summary(hant)).toMatch(/<span aria-hidden="true" lang="zh-Hant">繁<\/span>/)
  })

  test("carry a phone's language and theme in the footer, the language chosen and no theme", async () => {
    // Below `sm` the visitor's header has no room for the two circles (Tela v5): the footer has
    // them as a select and a segmented control. The page's language is the one selected, as the
    // cache is kept per language; the theme, as in the header's menu, is nobody's in particular.
    const choices = (html: string) =>
      html.match(/<div[^>]*data-testid="footer-choices"[^>]*>.*?<\/fieldset>/s)?.[0] ?? ''
    const fr = choices(await (await page('/about', { cookie: 'tela_locale=fr' })).text())
    expect(fr).toMatch(/<label[^>]*>Langue<\/label>/)
    expect(fr).toMatch(/<option value="fr" lang="fr" selected="">Français<\/option>/)
    expect(fr).toMatch(/<option value="zh-Hant" lang="zh-Hant">繁體中文<\/option>/)
    expect(fr).toContain('data-testid="footer-theme-dark"')
    expect(fr).toContain('Sombre')
    expect(fr).not.toContain('aria-pressed')
  })

  test("an info page renders in the reader's language, cached apart", async () => {
    const zh = await (await page('/terms', { cookie: 'tela_locale=zh-Hans' })).text()
    expect(zh).toContain('<html lang="zh-Hans"')
    expect(zh).toContain('<title>条款 · Tela</title>')
    expect(zh).toContain('id="writers"')
    expect(zh).toContain('最后更新：2026年10月25日')
    const en = await (await page('/terms')).text()
    expect(en).toContain('<html lang="en"')
    expect(en).toContain('<title>Terms · Tela</title>')
    expect(cache.size).toBe(2)
    expect(apiCalls).toEqual([])
  })

  test('Traditional Chinese and French have info pages of their own, chosen by the browser too', async () => {
    const hant = await (await page('/privacy', { 'accept-language': 'zh-TW,zh;q=0.8' })).text()
    expect(hant).toContain('<html lang="zh-Hant"')
    expect(hant).toContain('<title>隱私 · Tela</title>')
    expect(hant).toContain('最後更新：2026年10月25日')
    const fr = await (await page('/privacy', { cookie: 'tela_locale=fr' })).text()
    expect(fr).toContain('<html lang="fr"')
    expect(fr).toContain('<title>Confidentialité · Tela</title>')
    expect(fr).toContain('Dernière mise à jour : 25 octobre 2026')
    expect(fr).toContain('id="cookies"')
  })

  test('For writers renders here in all four languages, from the bundle alone (ADR 0061)', async () => {
    const titles: Record<string, string> = {
      en: 'For writers',
      'zh-Hans': '写作者',
      'zh-Hant': '寫作者',
      fr: 'Pour les auteurs',
    }
    for (const [locale, title] of Object.entries(titles)) {
      const res = await page('/writers', { cookie: `tela_locale=${locale}` })
      expect(res.status).toBe(200)
      expect(res.headers.get('x-robots-tag')).toBe('noindex, nofollow')
      expect(res.headers.get('content-language')).toBe(locale)
      const html = await res.text()
      expect(html).toContain(`<html lang="${locale}"`)
      expect(html).toContain(`<title>${title} · Tela</title>`)
      expect(html).toContain('data-testid="writers-page"')
      // A visitor's page: the form, never a member's links.
      expect(html).toContain('data-testid="writers-form"')
      expect(html).not.toContain('data-testid="writers-member"')
      // Each section under its anchor, the same in every language, and robots.txt's two lines.
      for (const id of ['reading', 'shows', 'claiming', 'opt-out'])
        expect(html).toContain(`id="${id}"`)
      expect(html).toContain('User-agent: Tela\nDisallow: /')
      expect(html).toContain('<code class="')
      expect(html).toContain('Tela/0.1 (+https://telaread.com; feed reader)')
      expect(html).toContain('href="mailto:me@hutu.si"')
      expect(html).not.toContain('id="tela-data"')
      expect(html).not.toContain('name="robots"')
    }
    const en = await (await page('/writers?utm_source=x')).text()
    expect(en).toMatch(
      /<meta name="description" content="Your calling card as an independent writer/,
    )
    expect(en).toContain('Only use what my feed provides')
    expect(en).toContain('fetches each new post’s public page once, soon after the feed lists it')
    const zh = await (await page('/writers', { cookie: 'tela_locale=zh-Hans' })).text()
    expect(zh).toContain('只用我的订阅源提供的内容')
    const fr = await (await page('/writers', { cookie: 'tela_locale=fr' })).text()
    expect(fr).toContain('N’utiliser que ce que fournit mon flux')
    // Nothing asked of tela-api, and one page per language: the campaign's query is not a page.
    expect(apiCalls).toEqual([])
    expect(cache.size).toBe(4)
  })

  test('nothing a blog says can close the handover script or become markup', async () => {
    await listedBlog(3, "</script><script>alert(1)</script> $& $'")
    const html = await (await page('/s/3')).text()
    expect(html).not.toContain('<script>alert(1)')
    expect(html).toContain('\\u003c/script>')
    expect(html).toContain('$&amp; $&#39;')
  })
})

describe('what search engines may index (ADR 0060)', () => {
  /** tela-web once TELA_NOINDEX is gone: launch day. */
  let indexing: ReturnType<typeof createEdge>
  beforeEach(() => {
    indexing = createEdge({
      blobs,
      api: { fetch: async (req) => api.app.fetch(req) },
      assets: {
        fetch: async () => new Response(TEMPLATE, { headers: { 'content-type': 'text/html' } }),
      },
      pages: pages as unknown as PublicPages,
      cache,
      fetchImage: async () => new Response('nope', { status: 404 }),
      config: { authSecret: 'a-test-secret-that-is-long-enough-for-hmac', noindex: false },
    })
  })
  const visit = (path: string, headers: Record<string, string> = {}) =>
    indexing.fetch(new Request(`${ORIGIN}${path}`, { headers }))
  const metaRobots = (html: string) =>
    html.match(/<meta name="robots" content="([^"]+)"/)?.[1] ?? null

  test("Tela's own pages and a blog an operator listed are indexed", async () => {
    await listedBlog(1, 'Garden Notes')
    for (const path of ['/discover/blogs', '/about', '/s/1', '/s/1']) {
      const res = await visit(path)
      expect(res.status).toBe(200)
      expect(res.headers.get('x-robots-tag')).toBeNull()
      expect(metaRobots(await res.text())).toBeNull()
    }
  })

  test('a claimed blog nobody reviewed is neither indexed nor followed, from the cache too', async () => {
    await listedBlog(2, 'Claimed Only', 'listed', null)
    for (const _ of [1, 2]) {
      const res = await visit('/s/2')
      expect(res.status).toBe(200)
      expect(res.headers.get('x-robots-tag')).toBe('noindex, nofollow')
      const html = await res.text()
      expect(metaRobots(html)).toBe('noindex, nofollow')
      expect(html).not.toContain('rel="canonical"')
    }
  })

  test('a blog nobody vouched for gets no followed link: its posts and its Visit say ugc nofollow', async () => {
    await listedBlog(1, 'Garden Notes')
    await listedBlog(2, 'Claimed Only', 'listed', null)
    const now = api.clock.now()
    await api.db.batch([
      bumpSeq(api.db),
      api.db.run(sql`insert into articles (id, feed_id, dedup_key, url, title, source_lang,
          fetched_at, sort_at, seq)
        values (1, 1, 'k1', 'https://blog1.example/p/1', 'Listed post', 'en', ${now}, ${now - 1},
            ${currentSeq}),
          (2, 2, 'k2', 'https://blog2.example/p/2', 'Claimed post', 'en', ${now}, ${now - 2},
            ${currentSeq})`),
    ] as never)
    const links = (html: string, host: string) =>
      [...html.matchAll(new RegExp(`<a [^>]*href="https://${host}[^"]*"[^>]*>`, 'g'))].map(
        (m) => m[0].match(/rel="([^"]+)"/)?.[1],
      )
    const listed = await (await visit('/s/1')).text()
    expect(links(listed, 'blog1.example')).toEqual(['noopener noreferrer', 'noopener noreferrer'])
    const claimed = await (await visit('/s/2')).text()
    expect(links(claimed, 'blog2.example')).toEqual([
      'ugc nofollow noopener noreferrer',
      'ugc nofollow noopener noreferrer',
    ])
    // Discover, as tela-api says of each post's blog.
    const articles = await (await visit('/discover/articles')).text()
    expect(links(articles, 'blog1.example/p/1')).toEqual(['noopener noreferrer'])
    expect(links(articles, 'blog2.example/p/2')).toEqual(['ugc nofollow noopener noreferrer'])
  })

  test("a new member's profile waits a week", async () => {
    const reader = await signedIn(api, 'fresh@x.test')
    await api.request('/api/v1/profile', {
      method: 'PUT',
      body: { handle: 'fresh' },
      as: reader,
    })
    const res = await visit('/@fresh')
    expect(res.status).toBe(200)
    expect(res.headers.get('x-robots-tag')).toBe('noindex, nofollow')
  })

  test('a page that does not exist, and the API, are never indexed', async () => {
    const missing = await visit('/s/999')
    expect(missing.status).toBe(404)
    expect(missing.headers.get('x-robots-tag')).toBe('noindex')
    expect((await visit('/api/health')).headers.get('x-robots-tag')).toBe('noindex')
    expect((await visit('/api/v1/public/discover')).headers.get('x-robots-tag')).toBe('noindex')
  })

  test('while TELA_NOINDEX is set, nothing is, whatever the page says', async () => {
    await listedBlog(1, 'Garden Notes')
    expect((await get('/s/1', null)).headers.get('x-robots-tag')).toBe('noindex, nofollow')
    expect((await get('/discover/blogs', null)).headers.get('x-robots-tag')).toBe(
      'noindex, nofollow',
    )
  })
})

describe('the language in the address (ADR 0060)', () => {
  const page = (path: string, headers: Record<string, string> = {}) =>
    edge.fetch(new Request(`${ORIGIN}${path}`, { headers }))
  const langOf = async (res: Response) => (await res.text()).match(/<html lang="([^"]+)"/)?.[1]
  /** The canonical address, as the attribute's value reads once unescaped. */
  const canonicalOf = (html: string) =>
    html.match(/<link rel="canonical" href="([^"]+)" \/>/)?.[1]?.replaceAll('&amp;', '&') ?? null

  test("a visitor's ?hl= beats their cookie and their browser, in any spelling", async () => {
    const chosen = { cookie: 'tela_locale=zh-Hans', 'accept-language': 'en-US,en;q=0.9' }
    expect(await langOf(await page('/about?hl=fr', chosen))).toBe('fr')
    expect(await langOf(await page('/about?hl=ZH-hant', chosen))).toBe('zh-Hant')
    // A language Tela has no interface in fixes nothing: the cookie decides, then the browser.
    expect(await langOf(await page('/about?hl=de', chosen))).toBe('zh-Hans')
    expect(await langOf(await page('/about?hl=de', { 'accept-language': 'fr-CA' }))).toBe('fr')
  })

  test("a member's own language wins over the address, and the page is then the unpinned one", async () => {
    const res = await page('/about?hl=fr', { cookie: `tela_locale=zh-Hans; ${cookie}` })
    const html = await res.text()
    expect(html).toContain('<html lang="zh-Hans"')
    expect(canonicalOf(html)).toBe(`${ORIGIN}/about`)
    expect(res.headers.get('vary')).toBe('cookie, accept-language')
    // A member with no language of their own on this browser yet: their browser's, still.
    const fresh = await page('/about?hl=fr', {
      cookie: 'tela.session_token=abc.def',
      'accept-language': 'en',
    })
    expect(await langOf(fresh)).toBe('en')
    // A member whose own language is the one named gets the pinned page, as a visitor would.
    const own = await (await page('/about?hl=fr', { cookie: `tela_locale=fr; ${cookie}` })).text()
    expect(canonicalOf(own)).toBe(`${ORIGIN}/about?hl=fr`)
  })

  test('a pinned page is a page of its own, canonical at its ?hl= address, from the same answer', async () => {
    await listedBlog(1, 'Garden Notes')
    const pinned = await page('/discover/blogs?hl=fr')
    expect(pinned.headers.get('vary')).toBe('cookie')
    expect(pinned.headers.get('content-language')).toBe('fr')
    expect(canonicalOf(await pinned.text())).toBe(`${ORIGIN}/discover/blogs?hl=fr`)
    const chosen = await page('/discover/blogs', { cookie: 'tela_locale=fr' })
    expect(chosen.headers.get('vary')).toBe('cookie, accept-language')
    expect(canonicalOf(await chosen.text())).toBe(`${ORIGIN}/discover/blogs`)
    // Another spelling, or noise beside it, is the same pinned page, canonical as it was.
    const again = await (await page('/discover/blogs?utm_source=x&hl=FR')).text()
    expect(canonicalOf(again)).toBe(`${ORIGIN}/discover/blogs?hl=fr`)
    await page('/discover/blogs', { cookie: 'tela_locale=fr' })
    // One answer from tela-api, two French pages: the JSON's copy and each page's.
    expect(apiCalls.filter((p) => p.startsWith('/api/v1/public/'))).toEqual([
      '/api/v1/public/discover',
    ])
    expect(cache.size).toBe(3)
  })

  test("a filter stays in the canonical address beside ?hl=, and a page's own query is kept", async () => {
    await listedBlog(1, 'Garden Notes')
    const html = await (await page('/discover/blogs?hl=zh-hans&page=1&topic=nope')).text()
    expect(canonicalOf(html)).toBe(`${ORIGIN}/discover/blogs?hl=zh-Hans`)
    const translated = await (await page('/?titles=translated&hl=fr')).text()
    expect(canonicalOf(translated)).toBe(`${ORIGIN}/?titles=translated&hl=fr`)
  })
})

/** The front page's answer, as tela-api gives it (`/api/v1/public/front`). */
const FRONT: FrontData = {
  counts: { blogs: 35 },
  week: { blogs: 17, languages: 4, posts: 70 },
  edition: {
    span: 'week',
    posts: [
      {
        article: {
          id: 7,
          feedId: 3,
          url: 'https://ciudad.example/noche',
          title: 'La ciudad de noche',
          author: null,
          publishedAt: 0,
          fetchedAt: 0,
          sortAt: 0,
          sourceLang: 'es',
          excerpt: 'Un paseo largo por la ciudad.',
          contentKey: null,
          wordCount: 900,
          readingMinutes: 4,
          extractState: 'done',
          likeCount: 0,
          recommendCount: 0,
          seq: 1,
          titles: { en: 'The city at night', 'zh-Hans': '夜晚的城市' },
          excerpts: { en: 'A long walk through the city.' },
        },
        site: {
          id: 3,
          title: 'Ciudad',
          homeUrl: 'https://ciudad.example',
          faviconKey: null,
          primaryLang: 'es',
        },
        claimant: { handle: 'ana', displayName: 'Ana' },
      },
    ],
  },
}

describe('the front page (ADR 0035)', () => {
  let stored: { url: string; headers: Headers }[]
  /** tela-web with tela-api's front page answering `answer`, and every other path as it does. */
  function frontEdge(answer: () => Response | Promise<Response>, pageDeadlineMs?: number) {
    stored = []
    const colo = memoryCache()
    const recording: EdgeCache = {
      match: (key) => colo.match(key),
      put: async (key, response) => {
        stored.push({ url: key.url, headers: new Headers(response.headers) })
        await colo.put(key, response)
      },
    }
    return createEdge({
      blobs,
      api: {
        fetch: async (req) => {
          apiCalls.push(new URL(req.url).pathname)
          return new URL(req.url).pathname === '/api/v1/public/front'
            ? answer()
            : api.app.fetch(req)
        },
      },
      assets: {
        fetch: async () => new Response(TEMPLATE, { headers: { 'content-type': 'text/html' } }),
      },
      pages: pages as unknown as PublicPages,
      cache: recording,
      fetchImage: async () => new Response('nope', { status: 404 }),
      config: {
        authSecret: 'a-test-secret-that-is-long-enough-for-hmac',
        noindex: true,
        ...(pageDeadlineMs === undefined ? {} : { pageDeadlineMs }),
      },
    })
  }
  const json = () => Response.json(FRONT)
  const visit = (e: ReturnType<typeof createEdge>, path: string, headers = {}) =>
    e.fetch(new Request(`${ORIGIN}${path}`, { headers }))

  test("renders for a visitor with the edition handed over, and comes from the colo's cache after", async () => {
    const front = frontEdge(json)
    const res = await visit(front, '/')
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('public, max-age=0, must-revalidate')
    expect(res.headers.get('vary')).toBe('cookie, accept-language')
    expect(res.headers.get('x-robots-tag')).toBe('noindex, nofollow')
    const html = await res.text()
    expect(html).toContain('<title>Tela</title>')
    expect(html).toContain('35 independent blogs')
    expect(html).toContain('This week, 17 blogs wrote in 4 languages')
    expect(html).toMatch(/<h2 lang="es"[^>]*>.*La ciudad de noche/s)
    expect(html).toContain('Español')
    expect(html).toContain('href="/?titles=translated"')
    expect(html).toContain('data-testid="site-footer"')
    expect(html).not.toContain('name="robots"')
    // The view does not fade in over the copy the visitor is already reading.
    expect(html).not.toMatch(/<main[^>]*animate-fade/)
    const handed = JSON.parse(
      html.match(/<script id="tela-data" type="application\/json">(.*?)<\/script>/s)?.[1] ?? '',
    )
    expect(handed).toEqual({ path: '/api/v1/public/front', body: FRONT })

    // A campaign's query string is the same page, and the cache's; the browser still keys by cookie.
    const again = await visit(front, '/?utm_source=x')
    expect(again.headers.get('vary')).toBe('cookie, accept-language')
    expect(await again.text()).not.toContain('utm_source')
    expect(apiCalls).toEqual(['/api/v1/public/front'])
    // workerd ignores Vary on what it stores, and refuses `*`: the colo's copy carries none.
    expect(stored).toHaveLength(1)
    expect(stored[0]?.headers.get('vary')).toBeNull()
  })

  test("a member's request is the plain shell: tela-api is not asked, and nothing is cached", async () => {
    const front = frontEdge(json)
    for (const name of ['tela.session_token', '__Secure-tela.session_token']) {
      const res = await visit(front, '/', { cookie: `tela_locale=en; ${name}=abc.def` })
      expect(res.status).toBe(200)
      expect(await res.text()).toBe(TEMPLATE)
      expect(res.headers.get('vary')).toBe('cookie')
      expect(res.headers.get('x-robots-tag')).toBe('noindex, nofollow')
    }
    expect(apiCalls).toEqual([])
    expect(stored).toEqual([])
  })

  test('each title mode is a page of its own, cached apart', async () => {
    const front = frontEdge(json)
    const translated = await (await visit(front, '/?titles=translated')).text()
    expect(translated).toMatch(/<h2 lang="en"[^>]*>.*The city at night/s)
    expect(translated).toContain('Spanish')
    expect(translated).toContain('A long walk through the city.')
    const original = await (await visit(front, '/')).text()
    expect(original).toMatch(/<h2 lang="es"[^>]*>.*La ciudad de noche/s)
    await visit(front, '/?titles=translated')
    await visit(front, '/')
    expect(apiCalls).toHaveLength(2)
    expect(stored.map((s) => s.url.replace(/\/page\/[0-9a-f]+\//, '/page/'))).toEqual([
      'https://tela-edge.cache/page/en/?titles=translated',
      'https://tela-edge.cache/page/en/',
    ])
  })

  test('no front page from tela-api, a 404 included, is the plain shell as a 503, never kept', async () => {
    for (const status of [404, 503]) {
      const front = frontEdge(() => new Response('no', { status }))
      const res = await visit(front, '/')
      // The shell's head says noindex: as a 200 a crawler would drop the page (ADR 0060).
      expect(res.status).toBe(503)
      expect(res.headers.get('retry-after')).toBe('120')
      expect(res.headers.get('cache-control')).toBe('no-store')
      expect(await res.text()).toBe(TEMPLATE)
      expect(res.headers.get('vary')).toBe('cookie, accept-language')
      expect(res.headers.get('x-robots-tag')).toBe('noindex, nofollow')
      expect(stored).toEqual([])
    }
  })

  test('an empty edition says so, and counts nothing it does not have', async () => {
    const empty: FrontData = {
      counts: { blogs: 0 },
      week: { blogs: 0, languages: 0, posts: 0 },
      edition: { span: 'latest', posts: [] },
    }
    const html = await (
      await visit(
        frontEdge(() => Response.json(empty)),
        '/',
      )
    ).text()
    expect(html).toContain('No posts yet.')
    expect(html).toMatch(/A confluence of <em[^>]*>independent blogs\.<\/em>/)
    expect(html).not.toMatch(/\b0 independent blogs/)
    expect(html).not.toContain('The latest from')
    expect(html).not.toContain(' · </span>')
  })

  test('a tela-api that hangs or throws is the plain shell as a 503 too, in time, never kept', async () => {
    const errors = spyOn(console, 'error').mockImplementation(() => {})
    const answers = {
      hangs: () => new Promise<Response>(() => {}),
      throws: () => Promise.reject(new Error('the binding is gone')),
      'sends no JSON': async () => new Response('<html>', { status: 200 }),
    }
    try {
      for (const [how, answer] of Object.entries(answers)) {
        const front = frontEdge(answer, 50)
        const started = Date.now()
        const res = await visit(front, '/')
        expect(Date.now() - started, how).toBeLessThan(1_000)
        expect(res.status, how).toBe(503)
        expect(await res.text(), how).toBe(TEMPLATE)
        expect(res.headers.get('cache-control'), how).toBe('no-store')
        expect(res.headers.get('retry-after'), how).toBe('120')
        expect(stored, how).toEqual([])
      }
      expect(errors).toHaveBeenCalledTimes(3)
    } finally {
      errors.mockRestore()
    }
  })
})

/** A post on Discover, of blog `siteId` (whose feed has the same id), as tela-api gives it. */
function discoverPost(id: number, siteId: number, over: Partial<DiscoverPost> = {}): DiscoverPost {
  return {
    article: {
      id,
      feedId: siteId,
      url: `https://blog${siteId}.example/${id}`,
      title: `Post ${id}`,
      author: null,
      publishedAt: 0,
      fetchedAt: 0,
      sortAt: 0,
      sourceLang: 'en',
      excerpt: `What post ${id} is about.`,
      contentKey: null,
      wordCount: 900,
      readingMinutes: 4,
      extractState: 'done',
      likeCount: 0,
      recommendCount: 0,
      seq: 1,
    },
    site: {
      id: siteId,
      title: `Blog ${siteId}`,
      homeUrl: `https://blog${siteId}.example`,
      faviconKey: null,
      primaryLang: 'en',
      claimed: false,
    },
    weekRecs: 0,
    recommenders: [],
    note: null,
    ...over,
  }
}

function candidate(handle: string, over: Partial<ReaderCandidate> = {}): ReaderCandidate {
  return {
    id: `id-${handle}-0000`,
    handle,
    displayName: null,
    avatar: null,
    bio: null,
    recs: [],
    sites: null,
    recent: 0,
    withNote: 0,
    total: 0,
    early: null,
    sample: null,
    ...over,
  }
}

const anna = { id: 'id-anna-0000', handle: 'anna', displayName: 'Anna K', avatar: null }

/** This week as tela-api gives it: three posts recommended this week, so they lead. */
const WEEK: WeekData = {
  since: 0,
  recommended: [
    discoverPost(11, 1, {
      weekRecs: 5,
      recommenders: [anna.id],
      note: { text: 'Read it twice.', person: anna },
    }),
    discoverPost(12, 2, { weekRecs: 3 }),
    discoverPost(13, 3, { weekRecs: 2 }),
  ],
  edition: { span: 'week', posts: [discoverPost(14, 4), discoverPost(15, 5)] },
  newBlogs: [
    {
      id: 6,
      title: 'Fresh Blog',
      homeUrl: 'https://fresh.example',
      description: 'Just listed.',
      faviconKey: null,
      primaryLang: 'en',
      claimed: false,
      readerCount: null,
      feedId: 6,
      latestTitle: null,
      latestAt: null,
      postsLast30d: 2,
      topics: [],
    },
  ],
  readers: [candidate('reader_a', { recent: 2, total: 2 })],
}

describe("Discover's tabs (ADR 0044)", () => {
  let asked: string[]
  /** tela-web with tela-api's new Discover endpoints answering `answers`, and the rest as it does. */
  function tabsEdge(answers: Record<string, () => Response>) {
    asked = []
    return createEdge({
      blobs,
      api: {
        fetch: async (req) => {
          const url = new URL(req.url)
          apiCalls.push(url.pathname)
          asked.push(url.pathname + url.search)
          const answer = answers[url.pathname]
          return answer ? answer() : api.app.fetch(req)
        },
      },
      assets: {
        fetch: async () => new Response(TEMPLATE, { headers: { 'content-type': 'text/html' } }),
      },
      pages: pages as unknown as PublicPages,
      cache,
      fetchImage: async () => new Response('nope', { status: 404 }),
      config: { authSecret: 'a-test-secret-that-is-long-enough-for-hmac', noindex: true },
    })
  }
  const visit = (e: ReturnType<typeof createEdge>, path: string, headers = {}) =>
    e.fetch(new Request(`${ORIGIN}${path}`, { headers }))
  const handover = (html: string) =>
    JSON.parse(
      html.match(/<script id="tela-data" type="application\/json">(.*?)<\/script>/s)?.[1] ?? '',
    )

  test('This week is Discover: rendered with its answer handed over, and the cache after', async () => {
    const edge = tabsEdge({ '/api/v1/public/discover/week': () => Response.json(WEEK) })
    const res = await visit(edge, '/discover')
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('<title>Discover · Tela</title>')
    expect(html).toMatch(/<a[^>]*aria-current="page"[^>]*data-testid="discover-tab-week"/)
    expect(html).toContain('href="/discover/articles"')
    // Three recommended posts lead the week, the most recommended first, its note beside it.
    expect(html).toMatch(/data-testid="week-span" data-span="recommended"/)
    expect(html).toMatch(/data-testid="week-lead" data-article-id="11" data-site-id="1"/)
    expect(html).toContain('“Read it twice.”')
    expect(html).toContain('5 readers recommended it this week.')
    expect(html.match(/data-testid="discover-post"/g)).toHaveLength(4)
    expect(html).toContain('Recommended by 3 readers this week')
    expect(html).toContain('Fresh Blog')
    expect(html).toMatch(/data-testid="reader-card" data-handle="reader_a"/)
    // A visitor's Subscribe and Follow sign in first, and come back here.
    expect(html).toContain(`href="/login?next=${encodeURIComponent('/discover')}"`)
    expect(handover(html)).toEqual({ path: '/api/v1/public/discover/week', body: WEEK })

    // A campaign's query string is the same page, from the cache.
    const again = await (await visit(edge, '/discover?utm_source=x')).text()
    expect(again).toContain('data-testid="week-lead"')
    expect(again).not.toContain('utm_source')
    expect(asked).toEqual(['/api/v1/public/discover/week'])
  })

  test('an address from before the tabs is a permanent redirect to Blogs, whole, asking tela-api nothing', async () => {
    const edge = tabsEdge({})
    for (const cookie of [null, 'tela.session_token=abc.def']) {
      const res = await visit(edge, '/discover?topic=tech&door=login', cookie ? { cookie } : {})
      expect(res.status).toBe(301)
      expect(res.headers.get('location')).toBe('/discover/blogs?topic=tech&door=login')
      expect(res.headers.get('cache-control')).toBe('public, max-age=86400')
    }
    // HEAD too: link checkers and `curl -I` ask that way (OPERATIONS.md's check does).
    const head = await edge.fetch(new Request(`${ORIGIN}/discover?topic=tech`, { method: 'HEAD' }))
    expect(head.status).toBe(301)
    expect(head.headers.get('location')).toBe('/discover/blogs?topic=tech')
    expect(apiCalls).toEqual([])
    expect(cache.size).toBe(0)
  })

  test('no week from tela-api, a 404 included, is the plain shell as a 503, never kept', async () => {
    for (const status of [404, 503]) {
      const edge = tabsEdge({
        '/api/v1/public/discover/week': () => new Response('no', { status }),
      })
      const res = await visit(edge, '/discover')
      expect(res.status).toBe(503)
      expect(await res.text()).toBe(TEMPLATE)
      expect(res.headers.get('cache-control')).toBe('no-store')
      expect(res.headers.get('retry-after')).toBe('120')
    }
    expect(cache.size).toBe(0)
  })

  test('Articles reached by a cursor links to the page after it, and each sort is a page of its own', async () => {
    const answer: ArticlesData = {
      recommended: [discoverPost(21, 1, { weekRecs: 4 })],
      posts: [
        discoverPost(22, 2, {
          note: { text: 'A quiet one.', person: anna },
          recommenders: [anna.id],
        }),
        discoverPost(21, 1, { weekRecs: 4 }),
      ],
      next: '1000:5',
      languages: [{ lang: 'en', count: 2 }],
    }
    const edge = tabsEdge({ '/api/v1/public/discover/articles': () => Response.json(answer) })
    const html = await (await visit(edge, '/discover/articles?sort=new&cursor=2000:9')).text()
    expect(html).toContain('<title>Articles · Discover · Tela</title>')
    const more = html.match(/<a [^>]*data-testid="articles-more"[^>]*>/)?.[0] ?? ''
    expect(more).toContain('href="/discover/articles?sort=new&amp;cursor=1000%3A5"')
    expect(html).toMatch(/aria-current="page"[^>]*data-testid="articles-sort-new"/)
    // The newest alone, in the stream's order; the note as its reader wrote it.
    const listed = [...html.matchAll(/data-testid="discover-post" data-article-id="(\d+)"/g)]
    expect(listed.map((m) => m[1])).toEqual(['22', '21'])
    expect(html).toContain('“A quiet one.”')
    expect(html).toContain('— Anna K')
    expect(handover(html).path).toBe('/api/v1/public/discover/articles?cursor=2000%3A9')

    // The most recommended first, then the stream, each post once: the same answer, another page.
    const recs = await (await visit(edge, '/discover/articles')).text()
    const ranked = [...recs.matchAll(/data-testid="discover-post" data-article-id="(\d+)"/g)]
    expect(ranked.map((m) => m[1])).toEqual(['21', '22'])
    await visit(edge, '/discover/articles?sort=new&cursor=2000:9')
    expect(asked).toEqual([
      '/api/v1/public/discover/articles?cursor=2000%3A9',
      '/api/v1/public/discover/articles',
    ])
  })

  test('Readers for a visitor shows only the groups that need nothing of theirs', async () => {
    const early = discoverPost(31, 1)
    const pool: ReadersData = {
      readers: [
        // Would be "blogs" for a member who reads blog 1; a visitor has no blogs.
        candidate('blogs_only', { recs: [[31, 1]], total: 1 }),
        candidate('active_one', { recent: 1, total: 1 }),
        candidate('note_writer', { recent: 2, withNote: 2, total: 2 }),
        candidate('early_one', {
          early: { article: early.article, site: early.site, others: 3 },
          recent: 1,
          total: 1,
        }),
      ],
    }
    const edge = tabsEdge({ '/api/v1/public/discover/readers': () => Response.json(pool) })
    const html = await (await visit(edge, '/discover/readers')).text()
    expect(html).toContain('<title>Readers · Discover · Tela</title>')
    const groups = [...html.matchAll(/data-testid="reader-group" data-group="(\w+)"/g)]
    expect(groups.map((m) => m[1])).toEqual(['early', 'notes', 'active'])
    expect(html).toContain('Recommended “Post 31” before 3 other readers did')
    expect(html).toContain('Wrote a note with all 2 recommendations this month')
    // In the pool handed over, and nowhere on the page.
    expect(html.split('<script id="tela-data"')[0]).not.toContain('blogs_only')
    expect(html).toContain(`href="/login?next=${encodeURIComponent('/discover/readers')}"`)
  })
})

describe('blogrolls (ADR 0050)', () => {
  let asked: string[]
  /** tela-web with tela-api answering `answers` by path, as its blogroll endpoints will. */
  function rollsEdge(answers: Record<string, () => Response>) {
    asked = []
    return createEdge({
      blobs,
      api: {
        fetch: async (req) => {
          const url = new URL(req.url)
          apiCalls.push(url.pathname)
          asked.push(url.pathname + url.search)
          const answer = answers[url.pathname]
          return answer ? answer() : new Response('not found', { status: 404 })
        },
      },
      assets: {
        fetch: async () => new Response(TEMPLATE, { headers: { 'content-type': 'text/html' } }),
      },
      pages: pages as unknown as PublicPages,
      cache,
      fetchImage: async () => new Response('nope', { status: 404 }),
      config: { authSecret: 'a-test-secret-that-is-long-enough-for-hmac', noindex: true },
    })
  }
  const visit = (e: ReturnType<typeof createEdge>, path: string) =>
    e.fetch(new Request(`${ORIGIN}${path}`))
  const handover = (html: string) =>
    JSON.parse(
      html.match(/<script id="tela-data" type="application\/json">(.*?)<\/script>/s)?.[1] ?? '',
    )
  const cardsOf = (html: string) =>
    [...html.matchAll(/data-testid="blogroll-card" data-blogroll-id="(\w+)"/g)].map((m) => m[1])

  const ann = { id: 'id-ann-0000', handle: 'ann', displayName: 'Ann K', avatar: null }
  const blog = (id: number, name: string | null) => ({
    feedId: id,
    siteId: id,
    name,
    homeUrl: `https://blog${id}.example`,
  })
  const card = (id: string, name: string): BlogrollCard => ({
    id,
    name,
    description: 'Blogs by people who walk their cities.',
    owner: ann,
    blogCount: 6,
    blogs: [
      blog(1, 'Calle Toledo'),
      blog(2, null),
      blog(3, 'Kerbs'),
      blog(4, 'Ferry'),
      blog(5, 'Stairs'),
    ],
    publicSince: 1000,
    updatedAt: 2000,
  })
  const profile = (blogrolls: BlogrollCard[]): ProfileData => ({
    profile: { id: ann.id, handle: 'ann', displayName: 'Ann K', bio: null, memberSince: 0 },
    counts: { following: 0, followers: 0, recommendations: 0, liked: null, subscriptions: null },
    blogs: [],
    recommendations: [],
    subscriptions: null,
    liked: null,
    blogrolls,
  })

  test("Discover's Blogrolls renders for a visitor with its answer handed over, and the cache after", async () => {
    const answer: BlogrollsData = {
      blogrolls: [card('abcdefABCDEF', 'Cities, on foot'), card('0123456789ab', 'Software')],
      next: '900:0123456789ab',
    }
    const edge = rollsEdge({ '/api/v1/public/discover/blogrolls': () => Response.json(answer) })
    const res = await visit(edge, '/discover/blogrolls')
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('<title>Blogrolls · Discover · Tela</title>')
    expect(html).toMatch(/<a[^>]*aria-current="page"[^>]*data-testid="discover-tab-blogrolls"/)
    expect(html).toContain('Blogs that readers recommend as a set.')
    expect(cardsOf(html)).toEqual(['abcdefABCDEF', '0123456789ab'])
    expect(html).toContain('href="/l/abcdefABCDEF"')
    // Whose it is, five blogs as chips (a nameless one by its host), and how many it has.
    expect(html).toContain('Ann K')
    expect(html.split('<div id="root">')[1]?.split('Software')[0]).toContain(
      'title="blog2.example"',
    )
    expect(html.match(/<li title="/g)).toHaveLength(10)
    expect(html).toContain('6 blogs')
    // Why a member sees one is their device's: a visitor's page says nothing of it.
    expect(html).not.toContain('data-testid="blogroll-reason"')
    // More is a link, so the next page is reachable before any script.
    const more = html.match(/<a [^>]*data-testid="blogrolls-more"[^>]*>/)?.[0] ?? ''
    expect(more).toContain('href="/discover/blogrolls?cursor=900%3A0123456789ab"')
    expect(handover(html)).toEqual({ path: '/api/v1/public/discover/blogrolls', body: answer })

    // A campaign's query string, or a cursor tela-api never wrote, is the same page, cached.
    await visit(edge, '/discover/blogrolls?utm_source=x')
    await visit(edge, '/discover/blogrolls?cursor=nope')
    expect(asked).toEqual(['/api/v1/public/discover/blogrolls'])
    // A page reached by cursor is a page of its own.
    await visit(edge, '/discover/blogrolls?cursor=900:0123456789ab')
    expect(asked.at(-1)).toBe('/api/v1/public/discover/blogrolls?cursor=900%3A0123456789ab')
  })

  test("Discover's Blogrolls with none says so, and a tela-api without it is the plain shell", async () => {
    const empty = rollsEdge({
      '/api/v1/public/discover/blogrolls': () => Response.json({ blogrolls: [], next: null }),
    })
    const html = await (await visit(empty, '/discover/blogrolls')).text()
    expect(html).toContain('data-testid="blogrolls-empty"')
    expect(html).toContain('No public blogrolls yet.')
    expect(html).not.toContain('data-testid="blogrolls-more"')

    cache = memoryCache()
    const older = rollsEdge({})
    const res = await visit(older, '/discover/blogrolls')
    expect(res.status).toBe(503)
    expect(await res.text()).toBe(TEMPLATE)
    expect(cache.size).toBe(0)
  })

  test("a profile's Blogrolls tab shows a visitor the public ones, cached apart from its other tabs", async () => {
    const edge = rollsEdge({
      '/api/v1/public/profiles/ann': () =>
        Response.json(profile([card('abcdefABCDEF', 'Cities, on foot')])),
    })
    const html = await (await visit(edge, '/@ann?tab=blogrolls')).text()
    expect(html).toMatch(/<a[^>]*aria-current="page"[^>]*data-testid="profile-tab-blogrolls"/)
    expect(html).toMatch(/data-testid="profile-tab-blogrolls"[^>]*>Blogrolls<span[^>]*>1<\/span>/)
    expect(html).toContain('data-testid="profile-blogrolls"')
    expect(cardsOf(html)).toEqual(['abcdefABCDEF'])
    expect(html).toContain('href="/l/abcdefABCDEF"')
    // Three of its blogs by name, a nameless one by its host, then how many it has.
    const shown = html.split('<script id="tela-data"')[0] ?? ''
    expect(shown).toContain('Calle Toledo')
    expect(shown).toContain('blog2.example')
    expect(shown).toContain('Kerbs')
    expect(shown).not.toContain('Ferry')
    expect(shown).toContain('6 blogs')
    // The owner's parts are theirs alone: no intro, no New blogroll, nothing private.
    expect(html).not.toContain('data-testid="new-blogroll"')
    expect(html).not.toContain('data-testid="blogroll-private"')
    expect(html).not.toContain('Others can subscribe')

    const recs = await (await visit(edge, '/@ann')).text()
    expect(recs).toContain('data-testid="profile-recommendations"')
    expect(recs).toContain('data-testid="profile-tab-blogrolls"')
    expect(asked).toEqual(['/api/v1/public/profiles/ann', '/api/v1/public/profiles/ann'])
  })

  test('a profile with no public blogroll has no such tab, and asking for it is the first', async () => {
    const edge = rollsEdge({ '/api/v1/public/profiles/ann': () => Response.json(profile([])) })
    const html = await (await visit(edge, '/@ann?tab=blogrolls')).text()
    expect(html).toContain('data-testid="profile-recommendations"')
    expect(html).not.toContain('data-testid="profile-tab-blogrolls"')
    // An answer from a tela-api before blogrolls has none either.
    cache = memoryCache()
    const { blogrolls: _, ...older } = profile([])
    const old = rollsEdge({ '/api/v1/public/profiles/ann': () => Response.json(older) })
    const page = await (await visit(old, '/@ann?tab=blogrolls')).text()
    expect(page).toContain('data-testid="profile-recommendations"')
    expect(page).not.toContain('data-testid="profile-tab-blogrolls"')
  })

  test('a public blogroll is titled by its name, its answer handed over; any other is a 404 page', async () => {
    const answer: BlogrollData = {
      blogroll: {
        id: 'abcdefABCDEF',
        name: 'Cities, on foot',
        description: 'Blogs by people who walk their cities.',
        updatedAt: 2000,
      },
      owner: ann,
      blogs: [],
    }
    const edge = rollsEdge({
      '/api/v1/public/blogrolls/abcdefABCDEF': () => Response.json(answer),
      '/api/v1/public/blogrolls/0123456789ab': () =>
        Response.json({ ...answer, blogroll: { ...answer.blogroll, description: '' } }),
    })
    const res = await visit(edge, '/l/abcdefABCDEF?utm_source=x')
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('<title>Cities, on foot · Tela</title>')
    expect(html).toContain(
      '<meta name="description" content="Blogs by people who walk their cities." />',
    )
    expect(handover(html)).toEqual({ path: '/api/v1/public/blogrolls/abcdefABCDEF', body: answer })
    // With no description, it says whose it is.
    const bare = await (await visit(edge, '/l/0123456789ab')).text()
    expect(bare).toContain('<meta name="description" content="A blogroll by Ann K" />')

    // Private, deleted or unknown: tela-api's 404 is the page's answer, and no data goes over.
    const missing = await visit(edge, '/l/ZZZZZZZZZZZZ')
    expect(missing.status).toBe(404)
    const notFound = await missing.text()
    expect(notFound).toContain('data-testid="not-found"')
    expect(notFound).not.toContain('id="tela-data"')
    // Anything else under `/l/` is no page: the plain shell, asking tela-api nothing.
    const before = asked.length
    for (const path of ['/l/short', '/l/abcdefABCDEF/x', '/l/']) {
      const shell = await visit(edge, path)
      expect(shell.status).toBe(200)
      expect(await shell.text()).toBe(TEMPLATE)
    }
    expect(asked).toHaveLength(before)
  })
})

describe('writes to the API', () => {
  const post = (path: string, headers: Record<string, string>) =>
    edge.fetch(new Request(`${ORIGIN}${path}`, { method: 'POST', headers, body: '{}' }))

  test('must come from this origin, except from hubs and the admin script', async () => {
    const discover = '/api/v1/feeds/discover'
    expect((await post(discover, { cookie, origin: 'https://evil.example' })).status).toBe(403)
    expect((await post(discover, { cookie })).status).toBe(403)
    // Through to tela-api, which finds no URL in the body.
    expect((await post(discover, { cookie, origin: ORIGIN, ...client })).status).toBe(400)
    expect((await post('/api/websub/1', {})).status).not.toBe(403)
    // tela-api's own refusal (no bearer token), not the edge's.
    expect(await (await post('/api/admin/invite', {})).json()).toEqual({ error: 'forbidden' })
  })

  test("the admin console's writes take the cookie, so they come from this origin too", async () => {
    // ADR 0039: `/api/v1/admin/*`, never `/api/admin/*`, which any origin may write to.
    const act = '/api/v1/admin/act'
    expect((await post(act, { cookie, origin: 'https://evil.example', ...client })).status).toBe(
      403,
    )
    expect((await post(act, { cookie, ...client })).status).toBe(403)
  })
})

describe("Tela's own feeds (ADR 0062)", () => {
  const ROLL = 'abcdefABCDEF'
  const OWNER = 'member-anna-0000001'
  const feedOf = (path: string, headers: Record<string, string> = {}) =>
    edge.fetch(new Request(`${ORIGIN}${path}`, { headers }))

  async function write(...statements: unknown[]) {
    const db = api.db
    await db.batch([bumpSeq(db), ...statements] as never)
  }
  /** A blog and its feed, both numbered `id`. */
  async function blog(id: number, o: { listing?: string; optOut?: boolean; title?: string } = {}) {
    const db = api.db
    await write(
      db.run(sql`insert into sites (id, home_url, title, listing, translation_opt_out, created_at,
          updated_at, seq)
        values (${id}, ${`https://blog${id}.example`}, ${o.title ?? `Blog ${id}`},
          ${o.listing ?? 'listed'}, ${o.optOut ? 1 : 0}, 0, 0, ${currentSeq})`),
      db.run(sql`insert into feeds (id, site_id, feed_url, host, next_fetch_at, created_at,
          updated_at, seq)
        values (${id}, ${id}, ${`https://blog${id}.example/feed`}, ${`blog${id}.example`}, 0, 0,
          0, ${currentSeq})`),
    )
  }
  /** A post `ago` minutes old, its title and excerpt hashed `h<id>`. */
  async function post(id: number, feedId: number, title: string, ago: number, lang = 'en') {
    const db = api.db
    const now = api.clock.now()
    await write(
      db.run(sql`insert into articles (id, feed_id, dedup_key, url, title, excerpt, source_lang,
          fetched_at, sort_at, title_hash, seq)
        values (${id}, ${feedId}, ${`k${id}`}, ${`https://blog${feedId}.example/p/${id}`},
          ${title}, ${`About ${title}`}, ${lang}, ${now}, ${now - ago * 60_000}, ${`h${id}`},
          ${currentSeq})`),
    )
  }
  async function translated(id: number, lang: string, title: string) {
    const db = api.db
    await write(
      db.run(sql`insert into article_titles (article_id, lang, feed_id, title, excerpt, status,
          source_hash, updated_at, seq)
        values (${id}, ${lang}, (select feed_id from articles where id = ${id}), ${title},
          ${`${title} …`}, 'done', ${`h${id}`}, 0, ${currentSeq})`),
    )
  }
  async function blogroll(feeds: number[], o: { isPublic?: boolean; hiddenAt?: number } = {}) {
    const db = api.db
    await write(
      db.run(sql`insert into user (id, name, email, email_verified, created_at, updated_at)
        values (${OWNER}, 'anna', 'anna@x.test', 1, 0, 0)`),
      db.run(sql`insert into profiles (user_id, handle, display_name, created_at, updated_at, seq)
        values (${OWNER}, 'anna', 'Ana & <Co>', 0, 0, ${currentSeq})`),
      db.run(sql`insert into blogrolls (id, user_id, name, description, is_public, public_version,
          public_since, hidden_at, created_at, updated_at, seq)
        values (${ROLL}, ${OWNER}, 'Cities, on foot', '', ${o.isPublic === false ? 0 : 1}, 1, 1,
          ${o.hiddenAt ?? null}, 1, 1000, ${currentSeq})`),
      ...feeds.map((feedId, i) =>
        db.run(sql`insert into blogroll_blogs (blogroll_id, feed_id, user_id, note_at, added_at,
            updated_at, seq)
          values (${ROLL}, ${feedId}, ${OWNER}, 0, ${i + 1}, ${i + 1}, ${currentSeq})`),
      ),
    )
  }
  const rssTitles = (xml: string) => parseFeedText(xml, `${ORIGIN}/feed`).items.map((i) => i.title)

  test("a blogroll's RSS: its listed blogs' newest posts, in the language `hl` pins", async () => {
    await blog(1)
    await blog(2, { optOut: true })
    await blog(3, { listing: 'private' })
    await blogroll([1, 2, 3])
    await post(10, 1, 'Walking <Lisbon> & more', 10)
    await post(11, 2, 'Kerbs', 20)
    await post(12, 3, 'Unlisted', 5)
    await post(13, 1, 'Déjà en français', 30, 'fr')
    await translated(10, 'fr', 'Marcher à Lisbonne')
    await translated(10, 'zh-Hans', '漫步里斯本')
    await translated(10, 'zh-Hant', '漫步里斯本（繁）')
    // A row in the post's own language changes nothing, and an opted-out blog's none.
    await translated(13, 'fr', 'Ne jamais montrer')
    await translated(11, 'fr', 'Bordures')

    const res = await feedOf(`/l/${ROLL}.rss?hl=fr`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/rss+xml; charset=utf-8')
    expect(res.headers.get('x-robots-tag')).toBe('noindex')
    expect(res.headers.get('content-disposition')).toBeNull()
    const xml = await res.text()
    expect(XMLValidator.validate(xml)).toBe(true)
    const feed = parseFeedText(xml, `${ORIGIN}/l/${ROLL}.rss`)
    expect(feed.title).toBe('Cities, on foot')
    expect(feed.homeUrl).toBe(`${ORIGIN}/l/${ROLL}?hl=fr`)
    expect(feed.selfUrl).toBe(`${ORIGIN}/l/${ROLL}.rss?hl=fr`)
    expect(feed.language).toBe('fr')
    expect(feed.description).toBe(
      'Les derniers articles des blogs de Cities, on foot, une blogroll de Ana & <Co> sur Tela.',
    )
    expect(feed.items.map((i) => [i.title, i.url, i.author])).toEqual([
      ['Marcher à Lisbonne', 'https://blog1.example/p/10', 'Blog 1'],
      ['Kerbs', 'https://blog2.example/p/11', 'Blog 2'],
      ['Déjà en français', 'https://blog1.example/p/13', 'Blog 1'],
    ])
    // The excerpt goes with the title it belongs to, as text.
    expect(feed.items[0]?.summaryHtml).toContain('Marcher à Lisbonne …')
    expect(feed.items[1]?.summaryHtml).toContain('About Kerbs')
    // Never a body.
    expect(feed.items.every((i) => i.contentHtml === null)).toBe(true)

    // zh-Hant is the stored conversion, in any case `hl` is written in.
    expect(rssTitles(await (await feedOf(`/l/${ROLL}.rss?hl=ZH-hant`)).text())[0]).toBe(
      '漫步里斯本（繁）',
    )
    expect(rssTitles(await (await feedOf(`/l/${ROLL}.rss?hl=zh-Hans`)).text())[0]).toBe(
      '漫步里斯本',
    )
    // No `hl`, or one Tela does not have: every post as written, and no language.
    for (const path of [`/l/${ROLL}.rss`, `/l/${ROLL}.rss?hl=de`]) {
      const original = await (await feedOf(path)).text()
      expect(rssTitles(original)).toEqual(['Walking <Lisbon> & more', 'Kerbs', 'Déjà en français'])
      expect(original).not.toContain('<language>')
      expect(original).toContain(`<atom:link href="${ORIGIN}/l/${ROLL}.rss" rel="self"`)
    }
    // Every language from one read of tela-api: the colo keeps its answer.
    expect(apiCalls.filter((p) => p.startsWith('/api/v1/public/feeds/'))).toEqual([
      `/api/v1/public/feeds/blogrolls/${ROLL}`,
    ])
  })

  test("a blogroll's OPML: its listed blogs in its order, shown inline", async () => {
    await blog(1, { title: 'Garden & <Notes>' })
    await blog(2, { listing: 'private' })
    await blog(3, { listing: 'featured' })
    await blogroll([3, 2, 1])
    const res = await feedOf(`/l/${ROLL}.opml`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/x-opml; charset=utf-8')
    expect(res.headers.get('content-disposition')).toBe(
      `inline; filename="tela-blogroll-${ROLL}.opml"`,
    )
    const xml = await res.text()
    expect(XMLValidator.validate(xml)).toBe(true)
    expect(feedsFromOpml(xml)).toEqual([
      { url: 'https://blog3.example/feed', folder: null },
      { url: 'https://blog1.example/feed', folder: null },
    ])
    expect(xml).toContain('<title>Cities, on foot</title>')
    expect(xml).toContain('<ownerName>Ana &amp; &lt;Co&gt;</ownerName>')
    expect(xml).toContain(`<ownerId>${ORIGIN}/@anna</ownerId>`)
    expect(xml).toContain('text="Garden &amp; &lt;Notes&gt;"')
  })

  test('a feed is answered 304 while its bytes are the same, and HEAD has no body', async () => {
    await blog(1)
    await blogroll([1])
    await post(10, 1, 'One', 10)
    const first = await feedOf(`/l/${ROLL}.rss`)
    const etag = first.headers.get('etag') ?? ''
    expect(etag).toMatch(/^"[0-9a-f]{24}"$/)
    expect(first.headers.get('cache-control')).toBe('public, max-age=60')
    const again = await feedOf(`/l/${ROLL}.rss`, { 'if-none-match': `W/${etag}` })
    expect(again.status).toBe(304)
    expect(await again.text()).toBe('')
    const head = await edge.fetch(new Request(`${ORIGIN}/l/${ROLL}.rss`, { method: 'HEAD' }))
    expect(head.status).toBe(200)
    expect(head.headers.get('etag')).toBe(etag)
    expect(await head.text()).toBe('')
  })

  test('a hidden or unknown blogroll has no feeds, and a bad id asks tela-api nothing', async () => {
    await blog(1)
    await blogroll([1], { hiddenAt: 5 })
    for (const path of [`/l/${ROLL}.rss`, `/l/${ROLL}.opml`, '/l/ZZZZZZZZZZZZ.rss']) {
      const res = await feedOf(path)
      expect([path, res.status]).toEqual([path, 404])
      expect(res.headers.get('cache-control')).toBe('public, max-age=60')
    }
    const before = apiCalls.length
    for (const path of ['/l/short.rss', '/l/abcdefABCDE!.opml', '/l/.rss']) {
      expect([path, (await feedOf(path)).status]).toEqual([path, 404])
    }
    expect(apiCalls).toHaveLength(before)
  })

  test("the blogroll's page is still its page, and a feed's failure is a 503 nobody keeps", async () => {
    await blog(1)
    await blogroll([1])
    const page = await feedOf(`/l/${ROLL}`)
    expect(page.headers.get('content-type')).toContain('text/html')
    expect(await page.text()).toContain('data-testid="blogroll-page"')
    expect(apiCalls).toContain(`/api/v1/public/blogrolls/${ROLL}`)
    expect(apiCalls).not.toContain(`/api/v1/public/feeds/blogrolls/${ROLL}`)

    const down = createEdge({
      blobs,
      api: { fetch: async () => new Response('down', { status: 503 }) },
      assets: { fetch: async () => new Response(TEMPLATE) },
      pages: pages as unknown as PublicPages,
      cache: memoryCache(),
      fetchImage: async () => new Response('nope', { status: 404 }),
      config: { authSecret: 'a-test-secret-that-is-long-enough-for-hmac', noindex: false },
    })
    const res = await down.fetch(new Request(`${ORIGIN}/discover/articles.rss`))
    expect(res.status).toBe(503)
    expect(res.headers.get('cache-control')).toBe('no-store')
  })

  test('the pages name their feeds in their head, in their language, and link them', async () => {
    // In the head at Tela's address, as every address there is (ADR 0060); on the page, a path.
    await blog(1)
    await blog(2, { listing: 'private' })
    await blogroll([1, 2])
    const roll = await (await feedOf(`/l/${ROLL}`)).text()
    expect(roll).toContain(
      `<link rel="alternate" type="application/rss+xml" title="Cities, on foot · RSS" href="${ORIGIN}/l/${ROLL}.rss?hl=en" />`,
    )
    expect(roll).toContain(
      `<link rel="alternate" type="text/x-opml" title="Cities, on foot · OPML" href="${ORIGIN}/l/${ROLL}.opml" />`,
    )
    expect(roll).toContain(`href="/l/${ROLL}.rss?hl=en" type="application/rss+xml"`)

    const fr = { cookie: 'tela_locale=fr' }
    const articles = await (await feedOf('/discover/articles?topic=tech', fr)).text()
    expect(articles).toContain(
      `<link rel="alternate" type="application/rss+xml" title="Découvrir · Tela · RSS" href="${ORIGIN}/discover/articles.rss?topic=tech&amp;hl=fr" />`,
    )
    expect(articles).toContain(
      `<link rel="alternate" type="text/x-opml" title="Découvrir · Tela · OPML" href="${ORIGIN}/discover.opml?topic=tech&amp;hl=fr" />`,
    )
    // And at the foot of the page, for a person.
    expect(articles).toContain(
      'href="/discover/articles.rss?topic=tech&amp;hl=fr" type="application/rss+xml"',
    )
    for (const tab of [
      '/discover',
      '/discover/blogs',
      '/discover/blogrolls',
      '/discover/readers',
    ]) {
      const html = await (await feedOf(tab)).text()
      expect([tab, html.includes(`href="${ORIGIN}/discover.opml?hl=en"`)]).toEqual([tab, true])
      expect(html).toContain('data-testid="feed-links"')
    }
  })

  test('a blogroll of unlisted blogs offers no feeds: there would be nothing in them', async () => {
    await blog(2, { listing: 'private' })
    await blogroll([2])
    const html = await (await feedOf(`/l/${ROLL}`)).text()
    expect(html).toContain('data-testid="blogroll-page"')
    expect(html).not.toContain('rel="alternate"')
    expect(html).not.toContain('data-testid="feed-links"')
  })

  test("Discover's RSS and OPML: its public blogs and newest posts, by topic, titled in `hl`", async () => {
    await blog(1)
    await blog(2, { listing: 'featured' })
    await blog(3, { listing: 'private' })
    await write(
      api.db.run(sql`insert into site_topics (site_id, topic) values (1, 'tech'), (3, 'tech')`),
    )
    await post(10, 1, 'Rust tips', 10)
    await post(11, 2, 'Bread', 20)
    await post(12, 3, 'Hidden', 5)
    await translated(10, 'fr', 'Astuces Rust')

    const all = await (await feedOf('/discover/articles.rss')).text()
    expect(XMLValidator.validate(all)).toBe(true)
    expect(rssTitles(all)).toEqual(['Rust tips', 'Bread'])
    const allRead = parseFeedText(all, `${ORIGIN}/feed`)
    expect(allRead.title).toBe('Discover · Tela')
    expect(allRead.homeUrl).toBe(`${ORIGIN}/discover/articles?sort=new`)

    const tech = await (await feedOf('/discover/articles.rss?hl=fr&topic=tech&utm=x')).text()
    const read = parseFeedText(tech, `${ORIGIN}/feed`)
    expect(read.title).toBe('Tech · Découvrir · Tela')
    expect(read.description).toBe('Les derniers articles des blogs de l’annuaire de Tela.')
    expect(read.homeUrl).toBe(`${ORIGIN}/discover/articles?topic=tech&sort=new&hl=fr`)
    expect(read.selfUrl).toBe(`${ORIGIN}/discover/articles.rss?topic=tech&hl=fr`)
    expect(read.items.map((i) => i.title)).toEqual(['Astuces Rust'])

    const opml = await feedOf('/discover.opml?topic=tech')
    expect(opml.headers.get('content-disposition')).toBe(
      'inline; filename="tela-discover-tech.opml"',
    )
    const xml = await opml.text()
    expect(XMLValidator.validate(xml)).toBe(true)
    expect(feedsFromOpml(xml).map((f) => f.url)).toEqual(['https://blog1.example/feed'])
    expect(feedsFromOpml(await (await feedOf('/discover.opml')).text()).map((f) => f.url)).toEqual([
      'https://blog2.example/feed',
      'https://blog1.example/feed',
    ])
    // RSS and OPML of one topic are one read of tela-api; a topic Tela lacks is no topic.
    expect(apiCalls.filter((p) => p.startsWith('/api/v1/public/feeds/'))).toEqual([
      '/api/v1/public/feeds/discover',
      '/api/v1/public/feeds/discover',
    ])
    expect(await (await feedOf('/discover/articles.rss?topic=nope')).text()).toBe(all)
  })
})

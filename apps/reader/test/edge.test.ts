import { beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { bumpSeq, currentSeq } from '@tela/data'
import type { Blobs } from '@tela/platform'
import { memoryBlobs } from '@tela/platform/portable'
import { preferredLanguages, type UiLocale } from '@tela/shared'
import { sql } from 'drizzle-orm'
import { createTestApi, signedIn, type TestApi } from '../../api/test/helpers'
import { detectLocale } from '../src/i18n'
import { type PublicRoute, publicRoute, renderPublicPage } from '../src/ssr'
import type { FrontData } from '../src/views/types'
import { createEdge, type EdgeCache, type PublicPages } from '../worker/edge'

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
  locale: (request) =>
    detectLocale(
      request.headers.get('cookie') ?? '',
      preferredLanguages(request.headers.get('accept-language') ?? ''),
    ),
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
  cache = memoryCache()
  edge = createEdge({
    blobs: counted,
    api: {
      fetch: async (req) => {
        apiCalls.push(new URL(req.url).pathname)
        return api.app.fetch(req)
      },
    },
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
    config: { authSecret: 'a-test-secret-that-is-long-enough-for-hmac', privateBeta: true },
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
    expect((await get(`/img/${KEY}/0`)).status).toBe(502)
    // Not kept: the next request asks the image's host again.
    expect((await get(`/img/${KEY}/0`)).status).toBe(502)
    expect(fetched).toEqual(['https://img.example/a.png', 'https://img.example/a.png'])
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
      config: { authSecret: 'a-test-secret-that-is-long-enough-for-hmac', privateBeta: true },
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

async function listedBlog(id: number, title: string, listing = 'listed') {
  const db = api.db
  await db.batch([
    bumpSeq(db),
    db.run(sql`insert into sites (id, home_url, title, listing, primary_lang, created_at, updated_at, seq)
      values (${id}, ${`https://blog${id}.example`}, ${title}, ${listing}, 'en', 0, 0, ${currentSeq})`),
    db.run(sql`insert into feeds (id, site_id, feed_url, host, next_fetch_at, created_at, updated_at, seq)
      values (${id}, ${id}, ${`https://blog${id}.example/feed`}, ${`blog${id}.example`}, 0, 0, 0, ${currentSeq})`),
  ] as never)
}

describe('public pages', () => {
  const page = (path: string, headers: Record<string, string> = {}) =>
    edge.fetch(new Request(`${ORIGIN}${path}`, { headers }))

  test('render into the SPA shell with their data handed over, and come from the cache after', async () => {
    await listedBlog(1, 'Garden Notes')
    const res = await page('/discover')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    expect(res.headers.get('cache-control')).toBe('public, max-age=0, must-revalidate')
    const html = await res.text()
    expect(html).toContain('<title>Discover · Tela</title>')
    expect(html).toMatch(/<div id="root">.*Garden Notes.*<\/div><script id="tela-data"/s)
    expect(html).toContain('/assets/index-abc123.js')
    // The shell's own noindex is for the app; a public page is indexed as the edge's header says.
    expect(html).not.toContain('name="robots"')
    const handed = JSON.parse(
      html.match(/<script id="tela-data" type="application\/json">(.*?)<\/script>/s)?.[1] ?? '',
    )
    expect(handed.path).toBe('/api/v1/public/discover')
    expect(handed.body.sites[0].title).toBe('Garden Notes')

    await page('/discover?utm_source=x')
    expect(apiCalls.filter((p) => p.startsWith('/api/v1/public/'))).toEqual([
      '/api/v1/public/discover',
    ])
  })

  test("render in the reader's language, cached apart", async () => {
    await listedBlog(1, 'Garden Notes')
    const zh = await (await page('/discover', { cookie: 'tela_locale=zh-Hans' })).text()
    expect(zh).toContain('<html lang="zh-Hans"')
    expect(zh).toContain('发现')
    const en = await (await page('/discover')).text()
    expect(en).toContain('<html lang="en"')
    expect(apiCalls.filter((p) => p.startsWith('/api/v1/public/'))).toHaveLength(2)
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
    // A second visit to each is the cache's.
    await page('/@shown')
    await page('/@shown?tab=subscriptions')
    expect(apiCalls.filter((p) => p.startsWith('/api/v1/public/profiles/'))).toHaveLength(2)
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

  test('a page this build cannot render is the plain shell, not an error', async () => {
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
      config: { authSecret: 'a-test-secret-that-is-long-enough-for-hmac', privateBeta: true },
    })
    await listedBlog(4, 'Unrenderable')
    const logged: unknown[][] = []
    const error = console.error
    console.error = (...args: unknown[]) => void logged.push(args)
    try {
      const res = await throwing.fetch(new Request(`${ORIGIN}/s/4`))
      expect(res.status).toBe(200)
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
    expect(privacy).toContain('Last updated 3 October 2026')
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

  test("mark the visitor's language in the Read-in menu, as the cache is kept per language", async () => {
    const menu = (html: string) =>
      html.match(/<details[^>]*data-testid="visitor-locale"[^>]*>.*?<\/details>/s)?.[0] ?? ''
    const summary = (html: string) => html.match(/<summary.*?<\/summary>/s)?.[0] ?? ''
    const en = menu(await (await page('/privacy')).text())
    // The button names the language the page is in; the list names each in its own script.
    expect(summary(en)).toMatch(/Read in.*<span lang="en"[^>]*>EN<\/span>/s)
    expect(en).toMatch(/<button[^>]*aria-pressed="true"[^>]*data-testid="visitor-locale-en"/)
    expect(en).toMatch(/<button[^>]*aria-pressed="false"[^>]*data-testid="visitor-locale-zh-Hans"/)
    expect(en).toMatch(/<button[^>]*lang="zh-Hans"[^>]*>简体中文<\/button>/)
    const zh = menu(await (await page('/privacy', { cookie: 'tela_locale=zh-Hans' })).text())
    expect(summary(zh)).toMatch(/阅读语言.*<span lang="zh-Hans"[^>]*>简中<\/span>/s)
    expect(zh).toMatch(/<button[^>]*aria-pressed="true"[^>]*data-testid="visitor-locale-zh-Hans"/)
  })

  test("an info page renders in the reader's language, cached apart", async () => {
    const zh = await (await page('/terms', { cookie: 'tela_locale=zh-Hans' })).text()
    expect(zh).toContain('<html lang="zh-Hans"')
    expect(zh).toContain('<title>条款 · Tela</title>')
    expect(zh).toContain('id="writers"')
    expect(zh).toContain('最后更新：2026年10月3日')
    const en = await (await page('/terms')).text()
    expect(en).toContain('<html lang="en"')
    expect(en).toContain('<title>Terms · Tela</title>')
    expect(cache.size).toBe(2)
    expect(apiCalls).toEqual([])
  })

  test('nothing a blog says can close the handover script or become markup', async () => {
    await listedBlog(3, "</script><script>alert(1)</script> $& $'")
    const html = await (await page('/s/3')).text()
    expect(html).not.toContain('<script>alert(1)')
    expect(html).toContain('\\u003c/script>')
    expect(html).toContain('$&amp; $&#39;')
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
        privateBeta: true,
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
    expect(res.headers.get('vary')).toBe('cookie')
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
    expect(again.headers.get('vary')).toBe('cookie')
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

  test('no front page from tela-api, a 404 included, is the plain shell, never kept', async () => {
    for (const status of [404, 503]) {
      const front = frontEdge(() => new Response('no', { status }))
      const res = await visit(front, '/')
      expect(res.status).toBe(200)
      expect(await res.text()).toBe(TEMPLATE)
      expect(res.headers.get('vary')).toBe('cookie')
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

  test('a tela-api that hangs or throws is the plain shell too, in time, never kept', async () => {
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
        expect(res.status, how).toBe(200)
        expect(await res.text(), how).toBe(TEMPLATE)
        expect(res.headers.get('cache-control'), how).toBe('public, max-age=0, must-revalidate')
        expect(stored, how).toEqual([])
      }
      expect(errors).toHaveBeenCalledTimes(3)
    } finally {
      errors.mockRestore()
    }
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
})

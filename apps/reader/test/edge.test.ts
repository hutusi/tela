import { beforeEach, describe, expect, test } from 'bun:test'
import type { Blobs } from '@tela/platform'
import { memoryBlobs } from '@tela/platform/portable'
import { createTestApi, signedIn, type TestApi } from '../../api/test/helpers'
import { createEdge, type EdgeCache } from '../worker/edge'

const KEY = 'a'.repeat(32)
const OTHER = 'b'.repeat(32)
const ORIGIN = 'http://tela.test'

let api: TestApi
let blobs: ReturnType<typeof memoryBlobs>
let gets: string[]
let images: { url: string; response: () => Response }[]
let fetched: string[]
let cookie: string

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
  cache = memoryCache()
  edge = createEdge({
    blobs: counted,
    api: { fetch: async (req) => api.app.fetch(req) },
    cache,
    fetchImage: async (url) => {
      fetched.push(url)
      const found = images.find((i) => i.url === url)
      return found ? found.response() : new Response('nope', { status: 404 })
    },
    config: { authSecret: 'a-test-secret-that-is-long-enough-for-hmac', privateBeta: true },
  })
  cookie = (await signedIn(api)).cookie
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

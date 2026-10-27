import { beforeEach, describe, expect, test } from 'bun:test'
import { memoryBlobs } from '@tela/platform/portable'
import type { OpensDecision } from '@tela/shared'
import { type Authorization, contentKeyOf, createContent } from './content'
import { createMarks, type EdgeCache } from './marks'

const A = 'a'.repeat(32)
const B = 'b'.repeat(32)
const NOW = Date.UTC(2026, 9, 27, 12)
const MIDNIGHT = Date.UTC(2026, 9, 28)
const REFUSED = { error: 'post_limit', limit: 100, resetsAt: MIDNIGHT } as const

function memoryCache(): EdgeCache & { keys(): string[] } {
  const store = new Map<string, { body: ArrayBuffer; init: ResponseInit }>()
  return {
    keys: () => [...store.keys()],
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
    async delete(key) {
      return store.delete(key.url)
    },
  }
}

let blobs: ReturnType<typeof memoryBlobs>
let cache: ReturnType<typeof memoryCache>
let asked: string[][]
let decide: (keys: string[]) => Authorization
let fetched: string[]
let content: ReturnType<typeof createContent>

const allow = (keys: string[], refused: OpensDecision['refused'] = {}): Authorization => ({
  ok: true,
  decision: { allowed: keys.filter((k) => !refused[k]), refused },
})

beforeEach(async () => {
  blobs = memoryBlobs()
  cache = memoryCache()
  asked = []
  fetched = []
  decide = (keys) => allow(keys)
  content = createContent({
    blobs,
    cache,
    now: () => NOW,
    authorize: async (_request, keys) => {
      asked.push(keys)
      return decide(keys)
    },
    fetch: async (url) => {
      fetched.push(url)
      return new Response(new Uint8Array([1, 2]), { headers: { 'content-type': 'image/png' } })
    },
  })
  for (const k of [A, B]) {
    await blobs.put(
      `c/${k}.json`,
      JSON.stringify({ key: k, images: [`https://img.example/${k.slice(0, 1)}.png`] }),
    )
  }
  await blobs.put(`t/${A}/fr/0123abcd.json`, JSON.stringify({ lang: 'fr' }))
})

const get = (path: string) => new Request(`https://edge.test${path}`)
const serve = async (path: string) => {
  const res = await content.serve(get(path))
  if (!res) throw new Error(`${path} is not content`)
  return res
}

describe('content at the edge', () => {
  test('a translation, its chunks and an image are decided by their post', () => {
    expect(contentKeyOf(`c/${A}.json`)).toBe(A)
    expect(contentKeyOf(`t/${A}/fr/0123abcd.json`)).toBe(A)
    expect(contentKeyOf(`tc/${A}/fr/run-1/0.json`)).toBe(A)
    expect(contentKeyOf('r/abc.html')).toBe(null)
  })

  test('an object allowed is served immutable; a shape no object has asks nothing', async () => {
    const res = await serve(`/o/c/${A}.json`)
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('private, max-age=31536000, immutable')
    expect(res.headers.get('x-robots-tag')).toBe('noindex')
    expect(((await res.json()) as { key: string }).key).toBe(A)
    expect((await serve(`/o/t/${A}/fr/0123abcd.json`)).status).toBe(200)
    for (const path of ['/o/r/abc.html', '/o/%', '/o/bundle', `/img/${A}/x`])
      expect((await serve(path)).status).toBe(404)
    expect(asked).toEqual([[A], [A]])
    expect(await content.serve(get('/api/health'))).toBe(null)
  })

  test('a refused object is a 429 that says when, kept by nobody, and never read from the colo', async () => {
    await serve(`/o/c/${A}.json`) // now in the colo
    decide = (keys) => allow(keys, { [A]: REFUSED })
    for (const path of [`/o/c/${A}.json`, `/o/t/${A}/fr/0123abcd.json`, `/img/${A}/0`]) {
      const res = await serve(path)
      expect(res.status).toBe(429)
      expect(res.headers.get('retry-after')).toBe(String((MIDNIGHT - NOW) / 1000))
      expect(res.headers.get('cache-control')).toBe('no-store')
      expect(await res.json()).toEqual(REFUSED)
    }
    expect(fetched).toEqual([])
  })

  test("an edge's own refusal (no session, tela-api down) is the answer", async () => {
    decide = () => ({ ok: false, response: new Response('sign in first', { status: 401 }) })
    expect((await serve(`/o/c/${A}.json`)).status).toBe(401)
    expect((await serve(`/img/${A}/0`)).status).toBe(401)
    expect((await content.serveBundle(get('/o/bundle'), [A])).status).toBe(401)
  })

  test('a decision that names a key neither way serves nothing on it', async () => {
    decide = () => ({ ok: true, decision: { allowed: [], refused: {} } })
    expect((await serve(`/o/c/${A}.json`)).status).toBe(403)
  })

  test('a bundle carries what was allowed and lists what was refused, kept only when whole', async () => {
    const whole = await content.serveBundle(get('/o/bundle'), [A, B, 'nothex', A])
    expect(whole.headers.get('cache-control')).toBe('private, max-age=31536000, immutable')
    expect(Object.keys(((await whole.json()) as { objects: object }).objects)).toEqual([A, B])
    decide = (keys) => allow(keys, { [B]: REFUSED })
    const part = await content.serveBundle(get('/o/bundle'), [A, B, 'c'.repeat(32)])
    expect(part.status).toBe(200)
    expect(part.headers.get('cache-control')).toBe('no-store')
    const body = (await part.json()) as { objects: Record<string, unknown>; refused: unknown }
    expect(Object.keys(body.objects)).toEqual([A])
    expect(body.refused).toEqual({ [B]: REFUSED })
    expect(asked.at(-1)).toEqual([A, B, 'c'.repeat(32)])
  })

  test('an image is decided before the colo is read, and a session renewed says so', async () => {
    decide = (keys) => ({ ...allow(keys), setCookies: ['tela.session_data=x'] }) as Authorization
    const first = await serve(`/img/${A}/0`)
    expect(first.status).toBe(200)
    expect(first.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox")
    expect(first.headers.getSetCookie()).toEqual(['tela.session_data=x'])
    expect((await serve(`/img/${A}/0`)).status).toBe(200)
    expect(fetched).toEqual(['https://img.example/a.png'])
    expect(asked).toEqual([[A], [A]])
  })
})

describe('facts kept in the colo', () => {
  test('hold until their moment, and are forgotten on request', async () => {
    let now = NOW
    const marks = createMarks(cache, () => now)
    expect(await marks.has('x')).toBe(false)
    await marks.set('x', NOW + 60_000)
    expect(await marks.has('x')).toBe(true)
    now = NOW + 60_000
    expect(await marks.has('x')).toBe(false)
    now = NOW
    await marks.forget('x')
    expect(await marks.has('x')).toBe(false)
    // Already over: nothing is kept.
    await marks.set('y', NOW - 1)
    expect(cache.keys().some((k) => k.endsWith('/y'))).toBe(false)
  })
})

/**
 * `/api/v1/public/avatars/:userId` (ADR 0032): a member's Gravatar while they show it, at the
 * version their switch is at, fetched by its hash from a server that stands in for gravatar.com.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { sha256Hex } from '@tela/content/hash'
import { sql } from 'drizzle-orm'
import { FixtureServer } from '../../../packages/ingest/test/fixture-server'
import { AVATAR_CACHE } from '../src/routes/avatars'
import { createTestApi, type SignedIn, signedIn, type TestApi } from './helpers'

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])

let gravatar: FixtureServer
let api: TestApi
let reader: SignedIn
let path: string

beforeAll(async () => {
  gravatar = await FixtureServer.start()
})
afterAll(async () => {
  await gravatar.stop()
})

beforeEach(async () => {
  gravatar.reset()
  api = await createTestApi({ gravatarUrl: gravatar.url('/avatar') })
  reader = await signedIn(api, 'reader@x.test')
  // Gravatar hashes the address trimmed and lower-cased, whatever the row holds.
  await api.db.run(sql`update "user" set email = ' Reader@X.test ' where id = ${reader.userId}`)
  path = `/avatar/${await sha256Hex('reader@x.test')}`
  gravatar.set(path, (_req, res) => {
    res.writeHead(200, { 'content-type': 'image/png' })
    res.end(PNG)
  })
})

const at = 1790000000123

async function show(gravatarOn: boolean, when = at) {
  const res = await api.request('/api/v1/mutations', {
    body: {
      mutations: [{ mid: crypto.randomUUID(), at: when, type: 'setAvatar', gravatar: gravatarOn }],
    },
    as: reader,
  })
  expect(res.status).toBe(200)
}

const picture = (v: number | string, userId = reader.userId) =>
  api.request(`/api/v1/public/avatars/${userId}?v=${v}`)

describe('a member’s picture', () => {
  test('is their Gravatar while they show it, immutable at its version', async () => {
    await show(true)
    const res = await picture(at)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(res.headers.get('cache-control')).toBe(AVATAR_CACHE)
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox")
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG)
    // Asked for by the normalized address's hash, at a size, with no placeholder.
    expect(gravatar.requests.map((r) => r.path)).toEqual([path])
  })

  test('is none, without asking Gravatar, while hidden or at another version', async () => {
    expect((await picture(at)).status).toBe(404) // never turned on
    await show(true)
    expect((await picture(at + 1)).status).toBe(404) // a made-up version
    expect((await picture('x')).status).toBe(404)
    expect((await picture(at, 'not an id')).status).toBe(404)
    await show(false, at + 10)
    expect((await picture(at)).status).toBe(404) // turned off
    expect(gravatar.requests).toEqual([])
  })

  test('Refresh moves it to a new version, and the old one stops answering', async () => {
    await show(true)
    await show(true, at + 500)
    expect((await picture(at)).status).toBe(404)
    expect((await picture(at + 500)).status).toBe(200)
  })

  test('is none for a day when Gravatar has no picture for the address', async () => {
    gravatar.reset()
    await show(true)
    const res = await picture(at)
    expect(res.status).toBe(404)
    expect(res.headers.get('cache-control')).toBe('public, max-age=86400')
  })

  test('refuses what an <img> should not get, and says so uncached', async () => {
    await show(true)
    const answers: [string, (res: import('node:http').ServerResponse) => void][] = [
      ['svg', (res) => res.writeHead(200, { 'content-type': 'image/svg+xml' }).end('<svg/>')],
      [
        'too large',
        (res) =>
          res.writeHead(200, { 'content-type': 'image/png' }).end(new Uint8Array(600 * 1024)),
      ],
      ['an error', (res) => res.writeHead(503).end()],
      ['a redirect', (res) => res.writeHead(302, { location: 'http://127.0.0.1:1/x' }).end()],
      [
        // Headers first, then the connection drops: the fetch has resolved, the read rejects.
        'a body cut off',
        (res) => {
          res.writeHead(200, { 'content-type': 'image/png', 'content-length': '4096' })
          res.flushHeaders()
          res.write(PNG)
          setTimeout(() => res.destroy(), 50)
        },
      ],
    ]
    for (const [what, answer] of answers) {
      gravatar.set(path, (_req, res) => answer(res))
      const res = await picture(at)
      expect([what, res.status]).toEqual([what, 502])
      expect(res.headers.get('cache-control')).toBe('no-store')
    }
  })
})

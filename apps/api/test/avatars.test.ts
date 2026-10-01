/**
 * `/api/v1/public/avatars/:userId` (ADR 0032): a member's Gravatar while they show it, at the
 * version their switch is at, fetched by its hash from a server that stands in for gravatar.com.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { sha256Hex } from '@tela/content/hash'
import { sql } from 'drizzle-orm'
import { FixtureServer } from '../../../packages/ingest/test/fixture-server'
import { AVATAR_CACHE } from '../src/routes/avatars'
import { createTestApi, ORIGIN, type SignedIn, signedIn, type TestApi } from './helpers'

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
  // Gravatar has a picture for them, as the check found (ADR 0033).
  await api.db.run(sql`update profiles set gravatar_found = 1 where user_id = ${reader.userId}`)
  gravatar.set(path, (_req, res) => {
    res.writeHead(200, { 'content-type': 'image/png' })
    res.end(PNG)
  })
})

const at = 1790000000123
/** The version after the first "on", and after a Refresh. */
const FIRST = 1

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
    const res = await picture(FIRST)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(res.headers.get('cache-control')).toBe(AVATAR_CACHE)
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox")
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG)
    // Asked for by the normalized address's hash, at a size, with no placeholder.
    expect(gravatar.requests.map((r) => r.path)).toEqual([path])
  })

  test('is none, without asking Gravatar, unless shown and found, and at its version', async () => {
    const found = (v: number | null) =>
      api.db.run(sql`update profiles set gravatar_found = ${v} where user_id = ${reader.userId}`)
    await found(null)
    expect((await picture(0)).status).toBe(404) // on by default, but not asked about yet
    await found(0)
    expect((await picture(0)).status).toBe(404) // Gravatar said it has none
    await found(1)
    await show(true)
    expect((await picture(FIRST + 1)).status).toBe(404) // a made-up version
    expect((await picture('x')).status).toBe(404)
    expect((await picture(FIRST, 'not an id')).status).toBe(404)
    await show(false, at + 10)
    expect((await picture(FIRST)).status).toBe(404) // turned off
    expect(gravatar.requests).toEqual([])
  })

  test('Refresh moves it to a new version, and the old one stops answering', async () => {
    await show(true)
    await show(true, at + 500)
    expect((await picture(FIRST)).status).toBe(404)
    expect((await picture(FIRST + 1)).status).toBe(200)
  })

  test('is none for a day when Gravatar has no picture for the address', async () => {
    gravatar.reset()
    await show(true)
    const res = await picture(FIRST)
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
      const res = await picture(FIRST)
      expect([what, res.status]).toEqual([what, 502])
      expect(res.headers.get('cache-control')).toBe('no-store')
    }
  })
})

/** A PNG header for a `side` × `height` picture, and `fill` bytes so each one is its own file. */
const png = (side: number, height = side, fill = 1) =>
  new Uint8Array([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    0,
    0,
    0,
    13,
    0x49,
    0x48,
    0x44,
    0x52,
    (side >>> 24) & 255,
    (side >>> 16) & 255,
    (side >>> 8) & 255,
    side & 255,
    (height >>> 24) & 255,
    (height >>> 16) & 255,
    (height >>> 8) & 255,
    height & 255,
    8,
    6,
    0,
    0,
    0,
    ...new Array(64).fill(fill),
  ])

describe('an uploaded picture (ADR 0033)', () => {
  const send = (body: Uint8Array, method = 'PUT', as: SignedIn | null = reader) =>
    api.app.request(`${ORIGIN}/api/v1/avatar`, {
      method,
      headers: {
        origin: ORIGIN,
        'content-type': 'image/png',
        ...(as ? { cookie: as.cookie, ...as.headers } : {}),
      },
      ...(method === 'PUT' ? { body } : {}),
    })
  const stored = async () => (await api.blobs.list({ prefix: `avatars/${reader.userId}/` })).keys
  const answer = async (res: Response) => ((await res.json()) as { avatar: string | null }).avatar

  test('is checked by its bytes, kept, and served before any Gravatar', async () => {
    const file = png(256)
    const res = await send(file)
    expect(res.status).toBe(200)
    expect(await answer(res)).toBe(`/avatar/${reader.userId}?v=1`)
    expect(await stored()).toEqual([expect.stringMatching(/^avatars\/.+\/[0-9a-f]{16}\.png$/)])
    const served = await picture(1)
    expect(served.status).toBe(200)
    expect(served.headers.get('content-type')).toBe('image/png')
    expect(served.headers.get('cache-control')).toBe(AVATAR_CACHE)
    expect(served.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox")
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(file)
    // The member has a Gravatar, and it was not asked for.
    expect(gravatar.requests).toEqual([])
  })

  test('a new one is a new address, and the object it replaces is deleted', async () => {
    await send(png(256, 256, 1))
    const second = png(256, 256, 2)
    expect(await answer(await send(second))).toBe(`/avatar/${reader.userId}?v=2`)
    expect(await stored()).toHaveLength(1)
    expect((await picture(1)).status).toBe(404)
    expect(new Uint8Array(await (await picture(2)).arrayBuffer())).toEqual(second)
  })

  test('removed, it gives way to the Gravatar, or to the letter', async () => {
    await send(png(256))
    expect(await answer(await send(new Uint8Array(), 'DELETE'))).toBe(
      `/avatar/${reader.userId}?v=2`,
    )
    expect(await stored()).toEqual([])
    expect(new Uint8Array(await (await picture(2)).arrayBuffer())).toEqual(PNG) // the Gravatar
    // With no Gravatar either, there is no address at all; removing nothing changes nothing.
    await api.db.run(sql`update profiles set gravatar_found = 0 where user_id = ${reader.userId}`)
    await send(png(256))
    expect(await answer(await send(new Uint8Array(), 'DELETE'))).toBeNull()
    expect(await answer(await send(new Uint8Array(), 'DELETE'))).toBeNull()
    const version = await api.db.all<{ v: number }>(
      sql`select avatar_version as v from profiles where user_id = ${reader.userId}`,
    )
    expect(version[0]?.v).toBe(4)
  })

  test('refuses what is not a square picture of a sane size, and keeps nothing', async () => {
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>')
    expect((await send(svg)).status).toBe(415) // declared image/png; the bytes say otherwise
    expect((await send(png(300, 200))).status).toBe(422)
    expect((await send(png(32))).status).toBe(422)
    expect((await send(png(2048))).status).toBe(422)
    const huge = new Uint8Array(600 * 1024)
    huge.set(png(256))
    expect((await send(huge)).status).toBe(413)
    expect(await stored()).toEqual([])
  })

  test('is limited to twenty an hour, and needs a member', async () => {
    for (let i = 0; i < 20; i++) expect((await send(png(256, 256, i))).status).toBe(200)
    expect((await send(png(256, 256, 99))).status).toBe(429)
    expect((await send(png(256), 'PUT', null)).status).toBe(401)
  })
})

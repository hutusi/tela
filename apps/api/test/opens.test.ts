/** `POST /api/edge/opens`: what tela-web's edge asks before it serves a member content (ADR 0066). */
import { beforeEach, describe, expect, test } from 'bun:test'
import { nextUtcMidnight } from '@tela/data'
import { OPENS_KEYS_MAX } from '@tela/shared'
import { sql } from 'drizzle-orm'
import { createTestApi, operatorSets, type SignedIn, signedIn, type TestApi } from './helpers'

const key = (c: string) => c.repeat(32)
let api: TestApi
let reader: SignedIn

/** Feed 1 is followed by the reader, feed 2 is not; one post each, and two more on feed 2. */
async function seed() {
  await api.db.run(sql`insert into sites (id, home_url, created_at, updated_at)
    values (1, 'https://b.example', 0, 0)`)
  await api.db.run(sql`insert into feeds (id, site_id, feed_url, host, next_fetch_at, created_at, updated_at)
    values (1, 1, 'https://b.example/a', 'b.example', 0, 0, 0),
      (2, 1, 'https://b.example/b', 'b.example', 0, 0, 0)`)
  for (const [id, feed, c] of [
    [1, 1, 'a'],
    [2, 2, '1'],
    [3, 2, '2'],
    [4, 2, '3'],
  ] as const) {
    await api.db.run(sql`insert into articles (id, feed_id, dedup_key, fetched_at, sort_at,
        current_version, content_key)
      values (${id}, ${feed}, ${`g:${id}`}, 0, 0, 1, ${key(c)})`)
    await api.db.run(sql`insert into article_versions (article_id, version, provenance,
        content_key, norm_version, body_chars, created_at)
      values (${id}, 1, 'feed', ${key(c)}, 1, 10, 0)`)
  }
  await api.db.run(sql`insert into subscriptions (user_id, feed_id, watermark_id, created_at, updated_at)
    values (${reader.userId}, 1, 0, 0, 0)`)
}

/** The edge's call: the forwarded cookie, and none of a browser's headers. */
const opens = (keys: unknown, cookie: string | null = reader.cookie) =>
  api.app.request('http://tela.test/api/edge/opens', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify({ keys }),
  })

beforeEach(async () => {
  api = await createTestApi()
  reader = await signedIn(api)
  await seed()
})

describe('the opens decision (ADR 0066)', () => {
  test('needs a session, and nothing else a browser sends', async () => {
    expect((await opens([key('a')], null)).status).toBe(401)
    const res = await opens([key('a')])
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(await res.json()).toEqual({ allowed: [key('a')], refused: {} })
  })

  test('takes a bundle of content keys at most', async () => {
    for (const keys of [
      'nope',
      [key('a').toUpperCase()],
      [key('a'), 'x'],
      [1],
      Array.from({ length: OPENS_KEYS_MAX + 1 }, (_, i) => i.toString(16).padStart(32, '0')),
    ]) {
      const res = await opens(keys)
      expect([JSON.stringify(keys).slice(0, 40), res.status]).toEqual([
        JSON.stringify(keys).slice(0, 40),
        400,
      ])
    }
  })

  test('followed posts are free; others count against the day, and past it are refused', async () => {
    await operatorSets(api, 'member.unsubscribedPostsPerDay', 1)
    expect(await (await opens([key('a'), key('1')])).json()).toEqual({
      allowed: [key('a'), key('1')],
      refused: {},
    })
    expect(await (await opens([key('1'), key('2')])).json()).toEqual({
      allowed: [key('1')],
      refused: {
        [key('2')]: {
          error: 'post_limit',
          limit: 1,
          resetsAt: nextUtcMidnight(api.clock.now()),
        },
      },
    })
  })

  test('an admin is exempt, and writes nothing', async () => {
    await operatorSets(api, 'member.unsubscribedPostsPerDay', 0)
    await api.db.run(sql`update profiles set is_admin = 1 where user_id = ${reader.userId}`)
    expect((await (await opens([key('1'), key('2')])).json()) as object).toEqual({
      allowed: [key('1'), key('2')],
      refused: {},
    })
    expect(await api.db.all(sql`select * from post_opens`)).toEqual([])
  })

  test('a closed or suspended account is signed out, whatever its cookie still says', async () => {
    await api.db.run(sql`update profiles set suspended_at = 1 where user_id = ${reader.userId}`)
    expect((await opens([key('1')])).status).toBe(401)
    expect(await api.db.all(sql`select * from post_opens`)).toEqual([])
  })
})

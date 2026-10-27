/**
 * `GET /api/v1/account/usage` (ADR 0063): what the member has used of their limits today, live, for
 * Settings and for the subscription cap the reader checks before it subscribes.
 */
import { beforeEach, describe, expect, test } from 'bun:test'
import type { AccountUsage } from '@tela/shared'
import { sql } from 'drizzle-orm'
import { createTestApi, type SignedIn, signedIn, type TestApi } from './helpers'

let api: TestApi
let reader: SignedIn

beforeEach(async () => {
  api = await createTestApi()
  reader = await signedIn(api)
})

const usage = async (as = reader) => {
  const res = await api.request('/api/v1/account/usage', { as })
  expect(res.status).toBe(200)
  expect(res.headers.get('cache-control')).toBe('no-store')
  return (await res.json()) as AccountUsage
}

/** The fixture clock's next midnight, UTC. */
const NEXT_DAY = Date.UTC(2026, 8, 29)

describe('the usage answer', () => {
  test('a new member has used nothing, against the defaults', async () => {
    expect(await usage()).toEqual({
      translations: { perDay: 20, usedToday: 0, waiting: 0, resetsAt: NEXT_DAY },
      feeds: { perDay: 20, addedToday: 0, pending: 0 },
      subscriptions: { max: 300, count: 0 },
      posts: { perDay: 100, openedToday: 0, resetsAt: NEXT_DAY },
      exempt: false,
    })
  })

  test("counts the day's feeds, what waits, the subscriptions, and the day's translations", async () => {
    const now = api.clock.now()
    const day = new Date(now).toISOString().slice(0, 10)
    await api.db.batch([
      api.db.run(sql`insert into sites (id, home_url, created_at, updated_at)
        values (1, 'https://a.example', 0, 0)`),
      // Two added today, one yesterday: only today's count.
      ...[1, 2, 3].map((id) =>
        api.db.run(sql`insert into feeds (id, site_id, feed_url, host, next_fetch_at, added_by,
            created_at, updated_at)
          values (${id}, 1, ${`https://a.example/${id}`}, 'a.example', 0, ${reader.userId},
            ${id === 3 ? now - 86_400_000 : now}, 0)`),
      ),
      api.db.run(sql`insert into subscriptions (user_id, feed_id, created_at, updated_at)
        values (${reader.userId}, 1, 0, 0), (${reader.userId}, 2, 0, 0)`),
      api.db.run(sql`insert into subscriptions (user_id, feed_id, created_at, updated_at, deleted_at)
        values (${reader.userId}, 3, 0, 0, 1)`),
      api.db.run(sql`insert into pending_feeds (user_id, feed_url, queued_at)
        values (${reader.userId}, 'https://b.example/feed', ${now})`),
      api.db.run(sql`insert into usage_daily (subject, day, reserved, used, requests)
        values (${reader.userId}, ${day}, 0, 9000, 3), (${reader.userId}, '2026-09-27', 0, 1, 7)`),
      // One waits for tomorrow; one requested now does not wait.
      api.db.run(sql`insert into body_translations (content_key, lang, state, requested_by,
          due_at, updated_at)
        values ('c1', 'fr', 'requested', ${reader.userId}, ${NEXT_DAY}, ${now}),
          ('c2', 'fr', 'requested', ${reader.userId}, null, ${now})`),
      api.db.run(sql`insert into settings (key, value, updated_at)
        values ('member.feedsPerDay', '5', 0), ('member.maxSubscriptions', 'null', 0),
          ('member.unsubscribedPostsPerDay', '2', 0)`),
      // Two posts opened today from blogs they do not follow, and one yesterday (ADR 0066).
      api.db.run(sql`insert into post_opens (user_id, day, content_key, opened_at)
        values (${reader.userId}, ${day}, 'c1', ${now}), (${reader.userId}, ${day}, 'c2', ${now}),
          (${reader.userId}, '2026-09-27', 'c3', 0)`),
    ] as never)
    expect(await usage()).toEqual({
      translations: { perDay: 20, usedToday: 3, waiting: 1, resetsAt: NEXT_DAY },
      feeds: { perDay: 5, addedToday: 2, pending: 1 },
      subscriptions: { max: null, count: 2 },
      posts: { perDay: 2, openedToday: 2, resetsAt: NEXT_DAY },
      exempt: false,
    })
  })

  test("an admin's limits read as none", async () => {
    await api.db.run(sql`update profiles set is_admin = 1 where user_id = ${reader.userId}`)
    expect(await usage()).toMatchObject({
      translations: { perDay: null },
      feeds: { perDay: null },
      subscriptions: { max: null },
      posts: { perDay: null },
      exempt: true,
    })
  })
})

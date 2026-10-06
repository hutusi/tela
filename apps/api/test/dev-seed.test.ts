/**
 * `bun run dev:seed`'s statements against the real schema (ADR 0039): applied to a fresh, migrated
 * database, then read back through every admin area. A migration that renames a column the seed
 * writes, or a console read the seed's rows trip, fails here rather than on someone's laptop.
 */
import { beforeAll, describe, expect, test } from 'bun:test'
import type { AdminCounts, AdminOverview } from '@tela/shared/admin'
import { sql } from 'drizzle-orm'
import { SEED_MIN_SITES, type SeedSite, seedStatements } from '../scripts/dev-seed-data'
import { ADMIN_TOKEN, createTestApi, type SignedIn, signedIn, type TestApi } from './helpers'

let api: TestApi
let ops: SignedIn

beforeAll(async () => {
  api = await createTestApi()
  ops = await signedIn(api, 'ops@x.test')
  await api.request('/api/admin/admins', {
    body: { email: 'ops@x.test', admin: true },
    headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
  })
  const now = api.clock.now()
  const sites: SeedSite[] = []
  for (let i = 1; i <= 30; i++) {
    const home = `https://blog${i}.example`
    await api.db.run(sql`insert into sites (id, home_url, title, listing, created_at, updated_at)
      values (${i}, ${home}, ${`Blog ${i}`}, 'featured', ${now}, ${now})`)
    await api.db.run(sql`insert into feeds (id, site_id, feed_url, host, next_fetch_at, created_at,
        updated_at) values (${i}, ${i}, ${`${home}/feed`}, ${`blog${i}.example`}, ${now}, ${now},
        ${now})`)
    await api.db.run(sql`insert into articles (feed_id, dedup_key, url, title, fetched_at, sort_at,
        content_key) values (${i}, ${`a${i}`}, ${`${home}/post`}, 'A post', ${now}, ${now},
        ${`ck${i}`})`)
    sites.push({ id: i, homeUrl: home, feedId: i })
  }
  for (const statement of seedStatements({ now, sites, actor: ops.userId })) {
    await api.db.run(sql.raw(statement))
  }
})

async function get<T>(path: string): Promise<T> {
  const res = await api.request(`/api/v1/admin/${path}`, { as: ops })
  expect(res.status).toBe(200)
  return (await res.json()) as T
}

describe('the dev seed', () => {
  test('fills every queue the Overview shows', async () => {
    const counts = await get<AdminCounts>('counts')
    expect(counts).toEqual({ claims: 3, feeds: 5, dead: 5 })
    const overview = await get<AdminOverview>('overview')
    expect(overview.queues.candidates.count).toBe(3)
    expect(overview.activity.length).toBeGreaterThan(0)
  })

  test('reads back through every area and filter', async () => {
    const lists = [
      'claims?f=review',
      'claims?f=checking',
      'sites?f=attention',
      'feeds?f=failing',
      'feeds?f=timeout',
      'feeds?f=dead',
      'feeds?f=paused',
      'feeds?f=merged',
      'discover?f=candidates',
      'discover?f=hidden',
      'people?f=members',
      'invites?f=codes',
      'invites?f=waiting',
      'invites?f=revoked',
      'translation?f=blogs',
      'system?f=dead',
      'system?f=retrying',
      'system?f=resolved',
    ]
    for (const path of lists) {
      const list = await get<{ rows: unknown[] }>(path)
      expect({ path, some: list.rows.length > 0 }).toEqual({ path, some: true })
    }
    await get('translation/report')
    await get('system/report')
  })

  test('needs enough blogs to spread its states over', () => {
    expect(() => seedStatements({ now: 0, sites: [], actor: null })).toThrow(
      `at least ${SEED_MIN_SITES} blogs`,
    )
  })
})

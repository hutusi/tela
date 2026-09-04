import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { feeds, sites } from '@tela/db'
import { resetDatabase, startTestDb, type TestDb } from '@tela/db/testing'
import { PgBoss } from 'pg-boss'
import { feedHealth, healthProblems, queueHealth } from '../src/health'
import { ensureQueues, QUEUES } from '../src/queues'

let t: TestDb
let boss: PgBoss

beforeAll(async () => {
  t = await startTestDb()
  boss = new PgBoss({ connectionString: t.url, schema: 'pgboss', max: 2 })
  await boss.start()
  await ensureQueues(boss)
}, 120_000)

afterAll(async () => {
  await boss?.stop({ graceful: false })
  await t?.stop()
})

beforeEach(async () => {
  await resetDatabase(t.db)
  await t.db.execute('delete from pgboss.job')
})

describe('health', () => {
  test('reports queue depth, dead letters, and overdue feeds', async () => {
    await boss.send(QUEUES.feedFetch, { feedId: 1 }, { singletonKey: '1' })
    await boss.send(QUEUES.feedFetch, { feedId: 2 }, { singletonKey: '2' })
    await boss.send(`${QUEUES.translateTitle}.dead`, { articleId: 9, targetLang: 'en' })

    const queues = await queueHealth(t.db)
    const byName = Object.fromEntries(queues.map((q) => [q.name, q]))
    expect(byName[QUEUES.feedFetch]).toMatchObject({ queued: 2, active: 0, failed1h: 0 })
    expect(byName[QUEUES.feedFetch]?.oldestQueuedSec).toBeGreaterThanOrEqual(0)
    expect(byName[`${QUEUES.translateTitle}.dead`]).toMatchObject({ queued: 1 })

    const [site] = await t.db
      .insert(sites)
      .values({ homeUrl: 'https://blog.example', title: 'Blog' })
      .returning()
    const hourAgo = new Date(Date.now() - 3600_000)
    await t.db.insert(feeds).values([
      { siteId: site!.id, feedUrl: 'https://blog.example/a', nextFetchAt: hourAgo },
      { siteId: site!.id, feedUrl: 'https://blog.example/b', status: 'dead' },
      { siteId: site!.id, feedUrl: 'https://blog.example/c', fetchRegion: 'cn' },
    ])
    const fh = await feedHealth(t.db)
    expect(fh).toEqual({ active: 2, paused: 0, dead: 1, overdue: 1, relayed: 1 })

    const problems = healthProblems(queues, fh)
    expect(problems).toContain('translate.title.dead: 1 dead-lettered jobs')
    expect(problems).toContain('1 active feeds overdue')
    expect(problems.some((p) => p.startsWith('feed.fetch'))).toBe(false)
  })

  test('flags stale queues and recent failures', () => {
    const problems = healthProblems(
      [
        {
          name: 'feed.fetch',
          queued: 3,
          active: 0,
          retrying: 0,
          completed1h: 10,
          failed1h: 2,
          oldestQueuedSec: 900,
        },
      ],
      { active: 1, paused: 0, dead: 0, overdue: 0, relayed: 0 },
    )
    expect(problems).toEqual([
      'feed.fetch: 2 failed in the last hour',
      'feed.fetch: oldest job waiting 900s',
    ])
  })
})

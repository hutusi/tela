import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { articles, articleTranslations, feeds, sites } from '@tela/db'
import { resetDatabase, startTestDb, type TestDb } from '@tela/db/testing'
import { sql } from 'drizzle-orm'
import { PgBoss } from 'pg-boss'
import { ensureQueues, QUEUES, type TranslateBodyJob } from '../src/queues'
import { resweepStuckTranslations } from '../src/scheduler'

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
  await t.db.execute(sql`delete from pgboss.job where name = ${QUEUES.translateBody}`)
})

describe('resweepStuckTranslations', () => {
  test('re-sends translate.body for rows stuck in requested, once, and leaves fresh rows alone', async () => {
    const [site] = await t.db.insert(sites).values({ homeUrl: 'https://blog.example' }).returning()
    const [feed] = await t.db
      .insert(feeds)
      .values({ siteId: site!.id, feedUrl: 'https://blog.example/feed' })
      .returning()
    const [a, b, c] = await t.db
      .insert(articles)
      .values([1, 2, 3].map((n) => ({ feedId: feed!.id, dedupKey: `k${n}`, title: `T${n}` })))
      .returning({ id: articles.id })
    const tenMinutesAgo = new Date(Date.now() - 10 * 60_000)
    await t.db.insert(articleTranslations).values([
      { articleId: a!.id, targetLang: 'zh-Hans', status: 'requested', updatedAt: tenMinutesAgo },
      { articleId: b!.id, targetLang: 'zh-Hans', status: 'requested' },
      { articleId: c!.id, targetLang: 'zh-Hans', status: 'running', updatedAt: tenMinutesAgo },
    ])

    expect(await resweepStuckTranslations({ db: t.db, boss })).toBe(1)
    // Still queued under its singleton key: a second sweep is a no-op.
    expect(await resweepStuckTranslations({ db: t.db, boss })).toBe(0)
    const jobs = await boss.fetch<TranslateBodyJob>(QUEUES.translateBody, { batchSize: 10 })
    expect(jobs.map((j) => j.data)).toEqual([
      { articleId: a!.id, targetLang: 'zh-Hans', onDemand: true },
    ])
  })
})

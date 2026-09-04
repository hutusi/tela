import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { getConstructionPlans, PgBoss } from 'pg-boss'
import { requestBodyTranslation, setTranslationStatus } from '../src/queries'
import { createJobSender } from '../src/queue'
import { articles, articleTranslations, feeds, sites } from '../src/schema'
import { resetDatabase, startTestDb, type TestDb } from '../src/testing'
import { pgBossDatabase } from './pg-boss'

let t: TestDb
let boss: PgBoss

beforeAll(async () => {
  t = await startTestDb()
  await pgBossDatabase(t.db).executeSql(getConstructionPlans('pgboss'))
  boss = new PgBoss({ db: pgBossDatabase(t.db), schema: 'pgboss' })
  await boss.createQueue('translate.body', { policy: 'short', expireInSeconds: 300 })
}, 120_000)

afterAll(async () => {
  await t?.stop()
})

beforeEach(async () => {
  await resetDatabase(t.db)
  await pgBossDatabase(t.db).executeSql(`delete from pgboss.job where name = 'translate.body'`)
})

async function seedArticle(): Promise<number> {
  const [site] = await t.db.insert(sites).values({ homeUrl: 'https://blog.example' }).returning()
  const [feed] = await t.db
    .insert(feeds)
    .values({ siteId: site!.id, feedUrl: 'https://blog.example/feed' })
    .returning()
  const [article] = await t.db
    .insert(articles)
    .values({ feedId: feed!.id, dedupKey: 'k1', title: 'T', sourceLang: 'en', contentHash: 'h1' })
    .returning()
  return article!.id
}

const enqueue =
  (articleId: number) => async (tx: Parameters<Parameters<TestDb['db']['transaction']>[0]>[0]) => {
    await createJobSender(tx).send(
      'translate.body',
      { articleId, targetLang: 'zh-Hans', onDemand: true },
      { singletonKey: `${articleId}:zh-Hans`, priority: 10 },
    )
  }

describe('requestBodyTranslation', () => {
  test('writes the requested status and the job in one transaction', async () => {
    const id = await seedArticle()
    expect(await requestBodyTranslation(t.db, id, 'zh-Hans', 'h1', enqueue(id))).toBe('requested')
    const jobs = await boss.fetch<{ articleId: number; targetLang: string; onDemand: boolean }>(
      'translate.body',
      { batchSize: 10 },
    )
    expect(jobs.map((j) => j.data)).toEqual([
      { articleId: id, targetLang: 'zh-Hans', onDemand: true },
    ])
    const [row] = await t.db.select().from(articleTranslations)
    expect(row).toMatchObject({ articleId: id, status: 'requested', contentHash: 'h1' })
  })

  test('a failed enqueue rolls the status back, so the reader can ask again', async () => {
    const id = await seedArticle()
    await expect(
      requestBodyTranslation(t.db, id, 'zh-Hans', 'h1', async () => {
        throw new Error('queue unavailable')
      }),
    ).rejects.toThrow('queue unavailable')
    expect(await t.db.select().from(articleTranslations)).toHaveLength(0)
    expect(await boss.fetch('translate.body', { batchSize: 10 })).toEqual([])
    expect(await requestBodyTranslation(t.db, id, 'zh-Hans', 'h1', enqueue(id))).toBe('requested')
  })

  test('reports in-progress and ready rows without enqueueing again', async () => {
    const id = await seedArticle()
    let calls = 0
    const counting = async () => {
      calls += 1
    }
    expect(await requestBodyTranslation(t.db, id, 'zh-Hans', 'h1', counting)).toBe('requested')
    expect(await requestBodyTranslation(t.db, id, 'zh-Hans', 'h1', counting)).toBe('in_progress')
    await setTranslationStatus(t.db, id, 'zh-Hans', 'done', { html: '<p>x</p>', contentHash: 'h1' })
    expect(await requestBodyTranslation(t.db, id, 'zh-Hans', 'h1', counting)).toBe('ready')
    // A changed body makes the translation stale: requested again.
    expect(await requestBodyTranslation(t.db, id, 'zh-Hans', 'h2', counting)).toBe('requested')
    expect(calls).toBe(2)
  })
})

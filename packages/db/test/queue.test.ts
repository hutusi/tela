import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { sql } from 'drizzle-orm'
import { getConstructionPlans, PgBoss } from 'pg-boss'
import { createJobSender } from '../src/queue'
import { startTestDb, type TestDb } from '../src/testing'
import { pgBossDatabase } from './pg-boss'

let t: TestDb

beforeAll(async () => {
  t = await startTestDb()
  // Install the pg-boss schema the way the worker's boss.start() would.
  await pgBossDatabase(t.db).executeSql(getConstructionPlans('pgboss'))
}, 120_000)

afterAll(async () => {
  await t?.stop()
})

describe('createJobSender', () => {
  test('inserts jobs a real pg-boss instance fetches, with queue defaults and dedup', async () => {
    const boss = new PgBoss({ db: pgBossDatabase(t.db), schema: 'pgboss' })
    await boss.createQueue('feed.fetch', {
      policy: 'short',
      retryLimit: 3,
      retryDelay: 60,
      retryBackoff: true,
      expireInSeconds: 120,
    })

    const sender = createJobSender(t.db)
    const id = await sender.send('feed.fetch', { feedId: 42 }, { singletonKey: '42', priority: 5 })
    expect(id).toBeTruthy()
    // The short policy dedupes queued jobs by singleton key.
    expect(await sender.send('feed.fetch', { feedId: 42 }, { singletonKey: '42' })).toBeNull()
    // A deferred job is not fetchable yet.
    expect(await sender.send('feed.fetch', { feedId: 7 }, { startAfterSeconds: 3600 })).toBeTruthy()

    const jobs = await boss.fetch<{ feedId: number }>('feed.fetch', {
      includeMetadata: true,
      batchSize: 10,
    })
    expect(jobs.map((j) => j.data)).toEqual([{ feedId: 42 }])
    const job = jobs[0]
    expect(job?.retryLimit).toBe(3)
    expect(job?.retryDelay).toBe(60)
    expect(job?.retryBackoff).toBe(true)
    expect(job?.priority).toBe(5)
  })

  test('sending to a missing queue fails loudly', async () => {
    const sender = createJobSender(t.db)
    await expect(sender.send('nope', {})).rejects.toThrow(/does not exist/)
  })

  test('sends inside a transaction: a rollback takes the job with it', async () => {
    const boss = new PgBoss({ db: pgBossDatabase(t.db), schema: 'pgboss' })
    await boss.createQueue('translate.body', { policy: 'short', expireInSeconds: 300 })

    await expect(
      t.db.transaction(async (tx) => {
        await createJobSender(tx).send('translate.body', { articleId: 1 }, { singletonKey: '1' })
        throw new Error('status write failed')
      }),
    ).rejects.toThrow('status write failed')
    expect(await boss.fetch('translate.body', { batchSize: 10 })).toEqual([])

    await t.db.transaction(async (tx) => {
      await createJobSender(tx).send('translate.body', { articleId: 2 }, { singletonKey: '2' })
    })
    const jobs = await boss.fetch<{ articleId: number }>('translate.body', { batchSize: 10 })
    expect(jobs.map((j) => j.data)).toEqual([{ articleId: 2 }])
  })

  test('sendFrom inserts a job per source row, with the same queue defaults', async () => {
    const boss = new PgBoss({ db: pgBossDatabase(t.db), schema: 'pgboss' })
    await boss.createQueue('translate.title', {
      policy: 'short',
      retryLimit: 3,
      retryDelay: 30,
      retryBackoff: true,
      expireInSeconds: 120,
    })

    const sender = createJobSender(t.db)
    const source = sql`
      select jsonb_build_object('articleId', n, 'targetLang', 'zh-Hans') as data,
             n || ':zh-Hans' as singleton_key,
             5 as priority
      from generate_series(1, 3) as n
    `
    expect(await sender.sendFrom('translate.title', source)).toBe(3)
    // The singleton policy applies to the bulk path too: a second run adds nothing.
    expect(await sender.sendFrom('translate.title', source)).toBe(0)

    const jobs = await boss.fetch<{ articleId: number; targetLang: string }>('translate.title', {
      includeMetadata: true,
      batchSize: 10,
    })
    expect(jobs.map((j) => j.data.articleId).sort()).toEqual([1, 2, 3])
    expect(jobs.every((j) => j.data.targetLang === 'zh-Hans')).toBe(true)
    // Queue defaults must reach a bulk-inserted job exactly as they reach a single one.
    const job = jobs[0]
    expect(job?.retryLimit).toBe(3)
    expect(job?.retryDelay).toBe(30)
    expect(job?.retryBackoff).toBe(true)
    expect(job?.priority).toBe(5)
  })

  test('sendFrom on a missing queue fails loudly rather than reporting zero', async () => {
    const sender = createJobSender(t.db)
    await expect(
      sender.sendFrom(
        'nope',
        sql`select '{}'::jsonb as data, null as singleton_key, 0 as priority`,
      ),
    ).rejects.toThrow(/does not exist/)
  })
})

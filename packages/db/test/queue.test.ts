import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
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
})

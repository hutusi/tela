import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { startTestDb, type TestDb } from '@tela/db/testing'
import { PgBoss } from 'pg-boss'
import { ensureQueues, QUEUES } from '../src/queues'

let t: TestDb
let boss: PgBoss

beforeAll(async () => {
  t = await startTestDb()
  boss = new PgBoss({ connectionString: t.url, schema: 'pgboss', max: 2 })
  await boss.start()
}, 120_000)

afterAll(async () => {
  await boss?.stop({ graceful: false })
  await t?.stop()
})

describe('ensureQueues', () => {
  test('is idempotent: a second run on existing queues updates settings without touching policy', async () => {
    await ensureQueues(boss)
    const first = await boss.getQueue(QUEUES.feedFetch)
    expect(first).toMatchObject({ policy: 'short', retryLimit: 3, deadLetter: 'feed.fetch.dead' })
    expect(await boss.getQueue('feed.fetch.dead')).toMatchObject({ policy: 'standard' })

    // Drift a mutable setting, then run again: it is restored and nothing throws.
    await boss.updateQueue(QUEUES.feedFetch, { retryLimit: 9 })
    await ensureQueues(boss)
    const second = await boss.getQueue(QUEUES.feedFetch)
    expect(second).toMatchObject({ policy: 'short', retryLimit: 3 })
    expect(await boss.getQueue(QUEUES.healthCheck)).toMatchObject({ policy: 'singleton' })
  })
})

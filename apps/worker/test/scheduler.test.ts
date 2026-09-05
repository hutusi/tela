import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { articles, articleTranslations, feeds, sites, translationRequests } from '@tela/db'
import { resetDatabase, startTestDb, type TestDb } from '@tela/db/testing'
import { eq, sql } from 'drizzle-orm'
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
  const userA = '11111111-1111-4111-8111-111111111111'
  const minutes = (n: number) => new Date(Date.now() - n * 60_000)
  async function seed(n: number): Promise<number[]> {
    await t.db.execute(sql`insert into auth.users (id, email) values (${userA}, 'a@x.test')`)
    const [site] = await t.db.insert(sites).values({ homeUrl: 'https://blog.example' }).returning()
    const [feed] = await t.db
      .insert(feeds)
      .values({ siteId: site!.id, feedUrl: 'https://blog.example/feed' })
      .returning()
    const rows = await t.db
      .insert(articles)
      .values(
        Array.from({ length: n }, (_, i) => ({
          feedId: feed!.id,
          dedupKey: `k${i}`,
          title: `T${i}`,
        })),
      )
      .returning({ id: articles.id })
    return rows.map((r) => r.id)
  }
  /** A row `age` minutes since its last write, with the request behind it; returns the attempt. */
  async function request(
    articleId: number,
    status: 'requested' | 'running',
    age: number,
    html: string | null = null,
    resends = 0,
  ): Promise<string> {
    const [row] = await t.db
      .insert(articleTranslations)
      .values({ articleId, targetLang: 'zh-Hans', status, updatedAt: minutes(age), html })
      .returning()
    await t.db.insert(translationRequests).values({
      articleId,
      targetLang: 'zh-Hans',
      requestedBy: userA,
      reservedTokens: 1234,
      resends,
    })
    return row!.attempt
  }
  const rowOf = async (articleId: number) => {
    const [r] = await t.db
      .select()
      .from(articleTranslations)
      .where(eq(articleTranslations.articleId, articleId))
    return r
  }
  const resendsOf = async (articleId: number) => {
    const [r] = await t.db
      .select()
      .from(translationRequests)
      .where(eq(translationRequests.articleId, articleId))
    return r?.resends
  }

  test('re-sends a requested row whose job was lost, under its own attempt, once', async () => {
    const [a, b, c] = (await seed(3)) as [number, number, number]
    const attempt = await request(a, 'requested', 10)
    await request(b, 'requested', 0)
    await request(c, 'running', 10) // heartbeat ten minutes ago: still alive
    expect(await resweepStuckTranslations({ db: t.db, boss })).toEqual({ resent: 1, abandoned: 0 })
    // Still queued under its singleton key: a second sweep is a no-op.
    expect(await resweepStuckTranslations({ db: t.db, boss })).toEqual({ resent: 0, abandoned: 0 })
    const jobs = await boss.fetch<TranslateBodyJob>(QUEUES.translateBody, { batchSize: 10 })
    // The requester and the attempt travel with the recovered job. The attempt is kept: a job
    // merely waiting in the queue carries the same one, and this send was then dropped.
    expect(jobs.map((j) => j.data)).toEqual([
      { articleId: a, targetLang: 'zh-Hans', onDemand: true, requestedBy: userA, attempt },
    ])
    expect((await rowOf(a))?.attempt).toBe(attempt)
  })

  test('a running row without a heartbeat goes back to requested under a fresh attempt, once per death', async () => {
    const [dead, live] = (await seed(2)) as [number, number]
    const deadAttempt = await request(dead, 'running', 20)
    await request(live, 'running', 2)
    expect(await resweepStuckTranslations({ db: t.db, boss })).toEqual({ resent: 1, abandoned: 0 })
    const jobs = await boss.fetch<TranslateBodyJob>(QUEUES.translateBody, { batchSize: 10 })
    expect(jobs.map((j) => j.data.articleId)).toEqual([dead])
    // The old attempt is retired in the same write: a worker still on it is refused next time.
    const row = await rowOf(dead)
    expect(row).toMatchObject({ status: 'requested' })
    expect(row?.attempt).not.toBe(deadAttempt)
    expect(jobs[0]?.data.attempt).toBe(row?.attempt as string)
    expect(await resendsOf(dead)).toBe(1)
    // The row is now a fresh `requested` one: the next tick neither rotates nor re-sends it.
    expect(await resweepStuckTranslations({ db: t.db, boss })).toEqual({ resent: 0, abandoned: 0 })
    expect((await rowOf(dead))?.attempt).toBe(row?.attempt as string)
    expect(await rowOf(live)).toMatchObject({ status: 'running' })
  })

  test('a running attempt that died past its replacements, or an hour ago, is given up', async () => {
    const [spent, gone] = (await seed(2)) as [number, number]
    const spentAttempt = await request(spent, 'running', 20, '<p>x</p>', 2)
    const goneAttempt = await request(gone, 'running', 90, '<p>x</p>')
    expect(await resweepStuckTranslations({ db: t.db, boss })).toEqual({ resent: 0, abandoned: 2 })
    expect(await boss.fetch(QUEUES.translateBody, { batchSize: 10 })).toEqual([])
    for (const [id, old] of [
      [spent, spentAttempt],
      [gone, goneAttempt],
    ] as const) {
      // Given up: the reservation is released and the reader may ask again; the id is retired.
      const row = await rowOf(id)
      expect(row).toMatchObject({ status: 'failed', html: null })
      expect(row?.attempt).not.toBe(old)
    }
  })

  test('rows in flight with no request behind them are given up: nothing can run them', async () => {
    const [x, y] = (await seed(2)) as [number, number]
    await t.db.insert(articleTranslations).values([
      { articleId: x, targetLang: 'zh-Hans', status: 'requested' },
      { articleId: y, targetLang: 'zh-Hans', status: 'running', html: '<p>x</p>' },
    ])
    expect(await resweepStuckTranslations({ db: t.db, boss })).toEqual({ resent: 0, abandoned: 2 })
    expect((await rowOf(x))?.status).toBe('failed')
    expect(await rowOf(y)).toMatchObject({ status: 'failed', html: null })
  })
})

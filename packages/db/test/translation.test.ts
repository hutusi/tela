import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { eq, sql } from 'drizzle-orm'
import { getConstructionPlans, PgBoss } from 'pg-boss'
import { requestBodyTranslation, setTranslationStatus, tokensUsedTodayBy } from '../src/queries'
import { createJobSender } from '../src/queue'
import {
  articles,
  articleTranslations,
  feeds,
  llmUsage,
  sites,
  translationRequests,
} from '../src/schema'
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
    // A changed body makes the translation stale: requested again, and the old html goes, so
    // nothing renders it as a translation of the new content.
    expect(await requestBodyTranslation(t.db, id, 'zh-Hans', 'h2', counting)).toBe('requested')
    expect(calls).toBe(2)
    const [stale] = await t.db.select().from(articleTranslations)
    expect(stale).toMatchObject({ status: 'requested', contentHash: 'h2', html: null })
  })
})

describe('tokensUsedTodayBy', () => {
  test("sums only the member's own calls from today", async () => {
    const userA = '11111111-1111-4111-8111-111111111111'
    const userB = '22222222-2222-4222-8222-222222222222'
    await t.db.execute(
      sql`insert into auth.users (id, email) values (${userA}, 'a@x.test'), (${userB}, 'b@x.test')`,
    )
    await t.db.insert(llmUsage).values([
      { job: 'translate.body', model: 'mock', inputTokens: 100, outputTokens: 50, userId: userA },
      { job: 'translate.body', model: 'mock', inputTokens: 7, outputTokens: 3, userId: userA },
      { job: 'translate.body', model: 'mock', inputTokens: 1000, outputTokens: 0, userId: userB },
      { job: 'translate.title', model: 'mock', inputTokens: 500, outputTokens: 0, userId: null },
    ])
    await t.db.execute(
      sql`update llm_usage set created_at = now() - interval '1 day' where input_tokens = 7`,
    )
    expect(await tokensUsedTodayBy(t.db, userA)).toBe(150)
    expect(await tokensUsedTodayBy(t.db, userB)).toBe(1000)
  })
})

describe('daily allowance reservations', () => {
  const userA = '11111111-1111-4111-8111-111111111111'
  const reserve = (reserveTokens: number) => ({
    requestedBy: userA,
    reserveTokens,
    allowanceTokens: 400_000,
  })
  async function twoArticles(): Promise<[number, number]> {
    await t.db.execute(sql`insert into auth.users (id, email) values (${userA}, 'a@x.test')`)
    const first = await seedArticle()
    const [feed] = await t.db.select({ id: feeds.id }).from(feeds).limit(1)
    const [second] = await t.db
      .insert(articles)
      .values({
        feedId: feed!.id,
        dedupKey: 'k2',
        title: 'T2',
        sourceLang: 'en',
        contentHash: 'h1',
      })
      .returning({ id: articles.id })
    return [first, second!.id]
  }

  test('reserves the estimate with the request and reconciles against recorded usage', async () => {
    const [first, second] = await twoArticles()
    expect(
      await requestBodyTranslation(t.db, first, 'zh-Hans', 'h1', enqueue(first), reserve(300_000)),
    ).toBe('requested')
    // Nothing is recorded yet, but 300k is reserved: another 300k does not fit.
    expect(
      await requestBodyTranslation(
        t.db,
        second,
        'zh-Hans',
        'h1',
        enqueue(second),
        reserve(300_000),
      ),
    ).toBe('budget_exhausted')
    expect(
      await t.db
        .select()
        .from(articleTranslations)
        .where(eq(articleTranslations.articleId, second)),
    ).toEqual([])

    // The first attempt concludes having actually cost 100k: its reservation is released.
    await setTranslationStatus(t.db, first, 'zh-Hans', 'done', {
      html: '<p>x</p>',
      contentHash: 'h1',
    })
    await t.db.insert(llmUsage).values({
      job: 'translate.body',
      model: 'mock',
      inputTokens: 60_000,
      outputTokens: 40_000,
      userId: userA,
    })
    expect(
      await requestBodyTranslation(
        t.db,
        second,
        'zh-Hans',
        'h1',
        enqueue(second),
        reserve(250_000),
      ),
    ).toBe('requested')
    const [request] = await t.db
      .select()
      .from(translationRequests)
      .where(eq(translationRequests.articleId, second))
    expect(request).toMatchObject({ requestedBy: userA, reservedTokens: 250_000 })
    // 100k recorded + 250k in flight leaves 50k: a changed body of the first article asking 100k is refused.
    expect(
      await requestBodyTranslation(t.db, first, 'zh-Hans', 'h2', enqueue(first), reserve(100_000)),
    ).toBe('budget_exhausted')
  })

  test('a reservation made yesterday still counts while its attempt is unfinished', async () => {
    const [first, second] = await twoArticles()
    expect(
      await requestBodyTranslation(t.db, first, 'zh-Hans', 'h1', enqueue(first), reserve(300_000)),
    ).toBe('requested')
    // The worker was down over midnight: the request is a day old and still queued.
    await t.db.execute(
      sql`update article_translations set updated_at = now() - interval '1 day' where article_id = ${first}`,
    )
    await t.db.execute(
      sql`update translation_requests set updated_at = now() - interval '1 day' where article_id = ${first}`,
    )
    expect(
      await requestBodyTranslation(
        t.db,
        second,
        'zh-Hans',
        'h1',
        enqueue(second),
        reserve(300_000),
      ),
    ).toBe('budget_exhausted')
  })
})

describe('tokensUsedTodayBy', () => {
  test("sums only the member's own calls from today", async () => {
    const userA = '11111111-1111-4111-8111-111111111111'
    const userB = '22222222-2222-4222-8222-222222222222'
    await t.db.execute(
      sql`insert into auth.users (id, email) values (${userA}, 'a@x.test'), (${userB}, 'b@x.test')`,
    )
    await t.db.insert(llmUsage).values([
      { job: 'translate.body', model: 'mock', inputTokens: 100, outputTokens: 50, userId: userA },
      { job: 'translate.body', model: 'mock', inputTokens: 7, outputTokens: 3, userId: userA },
      { job: 'translate.body', model: 'mock', inputTokens: 1000, outputTokens: 0, userId: userB },
      { job: 'translate.title', model: 'mock', inputTokens: 500, outputTokens: 0, userId: null },
    ])
    await t.db.execute(
      sql`update llm_usage set created_at = now() - interval '1 day' where input_tokens = 7`,
    )
    expect(await tokensUsedTodayBy(t.db, userA)).toBe(150)
    expect(await tokensUsedTodayBy(t.db, userB)).toBe(1000)
  })
})

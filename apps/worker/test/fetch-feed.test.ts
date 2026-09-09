import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { articles, articleTranslations, feeds, sites } from '@tela/db'
import { resetDatabase, startTestDb, type TestDb } from '@tela/db/testing'
import { createHttpClient, ensureFeed } from '@tela/ingest'
import { createMockTranslator } from '@tela/llm'
import { eq, sql } from 'drizzle-orm'
import { type Job, PgBoss } from 'pg-boss'
import type { WorkerContext } from '../src/context'
import { handleFeedFetch } from '../src/jobs/fetch-feed'
import { ensureQueues, type FeedFetchJob, QUEUES } from '../src/queues'
import { repairMissingTitleJobs } from '../src/title-jobs'
import { FixtureServer, longHtml, rss } from './fixture-server'

let t: TestDb
let boss: PgBoss
let server: FixtureServer
const http = createHttpClient({
  userAgent: 'TelaTest/1.0',
  politenessMs: 0,
  allowPrivateHosts: true,
  timeoutMs: 500,
})
const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url))

beforeAll(async () => {
  t = await startTestDb()
  server = await FixtureServer.start()
  boss = new PgBoss({ connectionString: t.url, schema: 'pgboss', max: 2 })
  await boss.start()
  await ensureQueues(boss)
}, 120_000)

afterAll(async () => {
  await boss?.stop({ graceful: false })
  await server.stop()
  await t?.stop()
})

beforeEach(async () => {
  server.reset()
  await resetDatabase(t.db)
  await t.db.execute(sql`delete from pgboss.job where name = ${QUEUES.translateTitle}`)
})

function ctx(): WorkerContext {
  return {
    db: t.db,
    boss,
    http,
    translator: createMockTranslator(),
    assets: null,
    config: { WEBSUB_ENABLED: false, RELAY_CONTROL_URL: 'https://example.invalid/' },
  } as unknown as WorkerContext
}

describe('handleFeedFetch', () => {
  test('queues title jobs with the articles, one per reading language the article is not in', async () => {
    server.text(
      '/feed.xml',
      rss({
        link: server.url('/'),
        items: [1, 2].map((n) => ({
          guid: `post-${n}`,
          link: server.url(`/posts/${n}`),
          title: `Post ${n}`,
          description: `Summary ${n}`,
          content: longHtml(4),
          date: `Thu, 0${n} Sep 2026 08:00:00 GMT`,
        })),
      }),
    )
    const { feedId } = await ensureFeed(t.db, { feedUrl: server.url('/feed.xml') })
    const job = {
      id: crypto.randomUUID(),
      name: QUEUES.feedFetch,
      data: { feedId },
    } as Job<FeedFetchJob>
    await handleFeedFetch(ctx(), [job])

    const stored = await t.db
      .select({ id: articles.id, sourceLang: articles.sourceLang })
      .from(articles)
      .where(eq(articles.feedId, feedId))
    expect(stored).toHaveLength(2)
    expect(stored.every((a) => a.sourceLang === 'en')).toBe(true)
    const queued = await t.db.execute<{ singleton_key: string }>(
      sql`select singleton_key from pgboss.job where name = ${QUEUES.translateTitle} order by singleton_key`,
    )
    expect(queued.map((q) => q.singleton_key)).toEqual(stored.map((a) => `${a.id}:zh-Hans`).sort())

    // Same body again: nothing new is stored and nothing new is queued.
    await handleFeedFetch(ctx(), [job])
    const again = await t.db.execute<{ n: number }>(
      sql`select count(*)::int as n from pgboss.job where name = ${QUEUES.translateTitle}`,
    )
    expect(again[0]?.n).toBe(2)
  })
})

describe('repairMissingTitleJobs', () => {
  test('queues only eligible missing title pairs and is safe to repeat', async () => {
    const [site] = await t.db
      .insert(sites)
      .values({ homeUrl: 'https://repair.example' })
      .returning()
    const [feed] = await t.db
      .insert(feeds)
      .values({ siteId: site!.id, feedUrl: 'https://repair.example/feed' })
      .returning()
    const repaired = await t.db
      .insert(articles)
      .values([
        { feedId: feed!.id, dedupKey: 'en', title: 'English', sourceLang: 'en' },
        { feedId: feed!.id, dedupKey: 'zh', title: 'Chinese', sourceLang: 'zh-Hans' },
        { feedId: feed!.id, dedupKey: 'und', title: 'Unknown', sourceLang: null },
      ])
      .returning({ id: articles.id, sourceLang: articles.sourceLang })
    const unknown = repaired.find((row) => row.sourceLang === null)
    await t.db.insert(articleTranslations).values({
      articleId: unknown!.id,
      targetLang: 'zh-Hans',
      title: '已有标题',
      status: 'done',
    })

    const [optedOut] = await t.db
      .insert(sites)
      .values({ homeUrl: 'https://private.example', translationOptOut: true })
      .returning()
    const [privateFeed] = await t.db
      .insert(feeds)
      .values({ siteId: optedOut!.id, feedUrl: 'https://private.example/feed' })
      .returning()
    await t.db.insert(articles).values({
      feedId: privateFeed!.id,
      dedupKey: 'private',
      title: 'Private',
      sourceLang: 'en',
    })

    const { stdout } = await promisify(execFile)('bun', ['run', cli, 'repair-titles', '10'], {
      env: { ...process.env, DATABASE_URL: t.url },
    })
    expect(JSON.parse(stdout)).toMatchObject({
      command: 'repair-titles',
      limit: 10,
      selected: 3,
      enqueued: 3,
      alreadyQueued: 0,
    })
    // Repeating it now finds nothing to do: the candidate query itself excludes anything with a
    // live job, so the singleton key is a backstop for the race, not the only guard.
    expect(await repairMissingTitleJobs(t.db, 10)).toEqual({
      selected: 0,
      enqueued: 0,
      alreadyQueued: 0,
    })

    const queued = await t.db.execute<{
      singleton_key: string
      priority: number
      data: { articleId: number; targetLang: string }
    }>(sql`
      select singleton_key, priority, data
      from pgboss.job
      where name = ${QUEUES.translateTitle}
      order by singleton_key
    `)
    expect(queued.map((row) => row.singleton_key)).toEqual(
      repaired
        .filter((row) => row.sourceLang !== null)
        .map((row) => `${row.id}:${row.sourceLang === 'en' ? 'zh-Hans' : 'en'}`)
        .concat(`${unknown!.id}:en`)
        .sort(),
    )
    expect(queued.every((row) => row.priority === 5)).toBe(true)
    expect(queued.map((row) => row.data)).toEqual(
      queued.map((row) => {
        const [articleId, targetLang] = row.singleton_key.split(':')
        return { articleId: Number(articleId), targetLang: targetLang as string }
      }),
    )
  })

  test('skips a title already in flight, not just one still queued', async () => {
    const [site] = await t.db
      .insert(sites)
      .values({ homeUrl: 'https://inflight.example' })
      .returning()
    const [feed] = await t.db
      .insert(feeds)
      .values({ siteId: site!.id, feedUrl: 'https://inflight.example/feed' })
      .returning()
    const [article] = await t.db
      .insert(articles)
      .values({ feedId: feed!.id, dedupKey: 'inflight', title: 'In flight', sourceLang: 'en' })
      .returning({ id: articles.id })

    expect(await repairMissingTitleJobs(t.db, 10)).toMatchObject({ enqueued: 1 })

    // pg-boss's `short` policy dedups created jobs only, so once the worker picks this up the
    // singleton key stops protecting us -- and t.title is still null the whole time it runs.
    await t.db.execute(
      sql`update pgboss.job set state = 'active'::pgboss.job_state
          where name = ${QUEUES.translateTitle} and singleton_key = ${`${article!.id}:zh-Hans`}`,
    )
    expect(await repairMissingTitleJobs(t.db, 10)).toEqual({
      selected: 0,
      enqueued: 0,
      alreadyQueued: 0,
    })
    const rows = await t.db.execute<{ n: number }>(
      sql`select count(*)::int as n from pgboss.job
          where name = ${QUEUES.translateTitle} and singleton_key = ${`${article!.id}:zh-Hans`}`,
    )
    expect(rows[0]?.n).toBe(1)
  })

  test('validates the repair batch limit', async () => {
    await expect(repairMissingTitleJobs(t.db, 0)).rejects.toThrow('integer from 1 to 5000')
    await expect(repairMissingTitleJobs(t.db, 5_001)).rejects.toThrow('integer from 1 to 5000')
  })
})

describe('worker:once fetch', () => {
  test('queues title jobs too, so a hand-seeded feed is not left untranslatable', async () => {
    // The CLI used to call fetchFeed with no options at all. onArticleStored is where title
    // jobs come from, so every feed seeded by hand landed articles nothing would translate.
    server.text(
      '/feed.xml',
      rss({
        link: server.url('/'),
        items: [
          {
            guid: 'post-1',
            link: server.url('/posts/1'),
            title: 'Post 1',
            description: 'Summary 1',
            content: longHtml(4),
            date: 'Thu, 03 Sep 2026 08:00:00 GMT',
          },
        ],
      }),
    )

    const { stdout } = await promisify(execFile)(
      'bun',
      ['run', cli, 'fetch', server.url('/feed.xml')],
      {
        env: { ...process.env, DATABASE_URL: t.url, WORKER_ALLOW_PRIVATE_HOSTS: '1' },
      },
    )
    expect(JSON.parse(stdout)).toMatchObject({ status: 'fetched', newArticles: 1, titleJobs: 1 })

    const [stored] = await t.db.select({ id: articles.id }).from(articles)
    const queued = await t.db.execute<{ singleton_key: string }>(
      sql`select singleton_key from pgboss.job where name = ${QUEUES.translateTitle}`,
    )
    expect(queued.map((q) => q.singleton_key)).toEqual([`${stored?.id}:zh-Hans`])
  }, 60_000)

  test('still ingests on a fresh database where pg-boss has never created its schema', async () => {
    await boss.stop({ graceful: false })
    await t.db.execute(sql`drop schema pgboss cascade`)
    try {
      server.text(
        '/feed.xml',
        rss({
          link: server.url('/'),
          items: [
            {
              guid: 'fresh-post',
              link: server.url('/posts/fresh'),
              title: 'Fresh post',
              description: 'Summary',
              content: longHtml(2),
              date: 'Thu, 03 Sep 2026 08:00:00 GMT',
            },
          ],
        }),
      )
      const { stdout, stderr } = await promisify(execFile)(
        'bun',
        ['run', cli, 'fetch', server.url('/feed.xml')],
        { env: { ...process.env, DATABASE_URL: t.url, WORKER_ALLOW_PRIVATE_HOSTS: '1' } },
      )
      expect(JSON.parse(stdout)).toMatchObject({ status: 'fetched', titleJobs: 0 })
      expect(stderr).toContain('seeding without title jobs')
      expect(await t.db.select({ id: articles.id }).from(articles)).toHaveLength(1)

      await expect(
        promisify(execFile)('bun', ['run', cli, 'repair-titles'], {
          env: { ...process.env, DATABASE_URL: t.url },
        }),
      ).rejects.toMatchObject({ stderr: expect.stringContaining('start the worker to create it') })
    } finally {
      boss = new PgBoss({ connectionString: t.url, schema: 'pgboss', max: 2 })
      await boss.start()
      await ensureQueues(boss)
    }
  }, 60_000)
})

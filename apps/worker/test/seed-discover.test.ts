import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { articles, feeds, sites } from '@tela/db'
import { resetDatabase, startTestDb, type TestDb } from '@tela/db/testing'
import { createHttpClient } from '@tela/ingest'
import { eq, sql } from 'drizzle-orm'
import { PgBoss } from 'pg-boss'
import { ensureQueues, QUEUES } from '../src/queues'
import type { CuratedSite } from '../src/seed/curated-sites'
import { seedDiscover } from '../src/seed/seed-discover'
import { FixtureServer, rss } from './fixture-server'

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
const run = promisify(execFile)

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
  await t.db.execute(sql`delete from pgboss.job`)
})

function blog(path: string, titles: string[], link = server.url('/')) {
  server.text(
    path,
    rss({
      link,
      items: titles.map((title, n) => ({
        guid: `${path}-${n}`,
        title,
        link: server.url(`/p/${n}`),
      })),
    }),
  )
  return { feedUrl: server.url(path), topics: ['tech'] } as const satisfies CuratedSite
}

async function titleJobs(): Promise<number> {
  const [row] = await t.db.execute<{ n: number }>(
    sql`select count(*)::int as n from pgboss.job where name = ${QUEUES.translateTitle}`,
  )
  return Number(row?.n ?? 0)
}

describe('seedDiscover', () => {
  test('fetches a blog, features its site with the editorial topics, and queues title jobs', async () => {
    const entry = {
      ...blog('/feed.xml', ['Hello', 'World']),
      topics: ['tech', 'essays'],
    } as CuratedSite
    const result = await seedDiscover(t.db, http, [entry])

    expect(result.titleQueue).toBe('ready')
    expect(result.totals).toMatchObject({ attempted: 1, curated: 1, errors: 0, newArticles: 2 })
    const [report] = result.entries
    expect(report).toMatchObject({
      outcome: 'created',
      fetch: 'fetched',
      articles: 2,
      listing: 'featured',
      listingChanged: true,
      topics: ['tech', 'essays'],
      topicsChanged: true,
      curated: true,
    })
    const [site] = await t.db.select().from(sites)
    expect(site?.listing).toBe('featured')
    expect(site?.topics).toEqual(['tech', 'essays'])
    // One target language per article: the mock feed has no language, so both targets apply...
    expect(await titleJobs()).toBe(result.totals.titleJobs)
    expect(result.totals.titleJobs).toBeGreaterThan(0)
  })

  test('a re-run stores nothing, queues nothing, and reports no change', async () => {
    const entry = blog('/feed.xml', ['Hello'])
    await seedDiscover(t.db, http, [entry])
    const jobsAfterFirst = await titleJobs()
    const [before] = await t.db.select().from(sites)

    const again = await seedDiscover(t.db, http, [entry])
    expect(again.totals).toMatchObject({ curated: 1, errors: 0, newArticles: 0, titleJobs: 0 })
    expect(again.entries[0]).toMatchObject({ listingChanged: false, topicsChanged: false })
    expect(await titleJobs()).toBe(jobsAfterFirst)
    expect((await t.db.select().from(articles)).length).toBe(1)
    const [after] = await t.db.select().from(sites)
    expect(after?.updatedAt).toEqual(before?.updatedAt as Date)
  })

  test('one bad feed is reported, left unlisted, and the run continues', async () => {
    // On its own origin, so its site is distinct from the good ones' and can be checked.
    const broken = await FixtureServer.start()
    try {
      broken.text('/missing.xml', 'gone', { status: 404 })
      const good = blog('/good.xml', ['Good'])
      const bad = { feedUrl: broken.url('/missing.xml'), topics: ['tech'] } as CuratedSite
      const alsoGood = blog('/also.xml', ['Also'])

      const result = await seedDiscover(t.db, http, [good, bad, alsoGood])
      expect(result.totals).toMatchObject({ attempted: 3, curated: 2, errors: 1 })
      expect(result.entries[1]).toMatchObject({ outcome: 'error', reason: 'fetch_failed' })
      expect(result.entries[1]?.errorKind).toMatch(/404/)
      expect(result.entries[2]?.curated).toBe(true)

      const [failed] = await t.db
        .select()
        .from(sites)
        .where(eq(sites.homeUrl, new URL(broken.url('/')).origin))
      expect(failed?.listing).toBe('private')
      const [shared] = await t.db
        .select()
        .from(sites)
        .where(eq(sites.homeUrl, new URL(server.url('/')).origin))
      expect(shared?.listing).toBe('featured')
    } finally {
      await broken.stop()
    }
  })

  test('features the site the feed ended up on, not the one ensureFeed guessed', async () => {
    // The feed declares another origin as its home, so fetchFeed moves it there. Curating
    // ensureFeed's placeholder would feature an empty site and leave the real one private.
    const home = 'https://declared.example'
    await t.db.insert(sites).values({ homeUrl: home, title: 'Declared' })
    const entry = blog('/moved.xml', ['Moved'], home)

    const result = await seedDiscover(t.db, http, [entry])
    const [feed] = await t.db.select().from(feeds)
    const [declared] = await t.db.select().from(sites).where(eq(sites.homeUrl, home))
    expect(result.entries[0]?.siteId).toBe(feed?.siteId as number)
    expect(feed?.siteId).toBe(declared?.id as number)
    expect(declared?.listing).toBe('featured')
    const others = await t.db.select().from(sites).where(sql`home_url <> ${home}`)
    expect(others.every((s) => s.listing === 'private')).toBe(true)
  })

  test('dry run writes nothing and reports what would change', async () => {
    const entry = blog('/feed.xml', ['Hello'])
    const planned = await seedDiscover(t.db, http, [entry], { dryRun: true })
    expect(planned.entries[0]).toMatchObject({
      outcome: 'skipped',
      reason: 'dry_run',
      feedId: null,
    })
    expect(await t.db.select().from(feeds)).toHaveLength(0)
    expect(server.requests).toHaveLength(0)

    await seedDiscover(t.db, http, [entry])
    const known = await seedDiscover(t.db, http, [entry], { dryRun: true })
    expect(known.entries[0]).toMatchObject({
      outcome: 'skipped',
      articles: 1,
      listing: 'featured',
      listingChanged: false,
      topicsChanged: false,
    })
  })

  test('limit and only select entries', async () => {
    const one = blog('/one.xml', ['One'])
    const two = blog('/two.xml', ['Two'])
    const three = blog('/three.xml', ['Three'])
    const entries = [one, two, three]

    const limited = await seedDiscover(t.db, http, entries, { limit: 2 })
    expect(limited.entries.map((e) => e.feedUrl)).toEqual([one.feedUrl, two.feedUrl])

    const picked = await seedDiscover(t.db, http, entries, { only: '/three.xml' })
    expect(picked.entries.map((e) => e.feedUrl)).toEqual([three.feedUrl])
  })
})

describe('the seed-discover command', () => {
  test('dry-runs against the real list and rejects an unknown flag', async () => {
    const { stdout } = await run(
      'bun',
      ['run', cli, 'seed-discover', '--dry-run', '--limit', '1'],
      {
        env: { ...process.env, DATABASE_URL: t.url },
      },
    )
    const result = JSON.parse(stdout)
    expect(result.totals.attempted).toBe(1)
    expect(result.entries[0].outcome).toBe('skipped')

    await expect(
      run('bun', ['run', cli, 'seed-discover', '--bogus'], {
        env: { ...process.env, DATABASE_URL: t.url },
      }),
    ).rejects.toMatchObject({ code: 2 })
  })
})

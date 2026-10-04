import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import {
  bumpSeq,
  first,
  headSeq,
  mergeFeed,
  startLease,
  type TelaDb,
  TITLES_PER_JOB,
  utcDay,
} from '@tela/data'
import { addTestUser, createTestDb } from '@tela/data/testing'
import { createHttpClient } from '@tela/ingest/http'
import { registerFeed } from '@tela/ingest/pipeline'
import {
  createMockTranslator,
  estimateTokens,
  type TranslationRequest,
  type Translator,
} from '@tela/llm'
import { fakeClock, memoryBlobs, memoryJobs } from '@tela/platform/portable'
import { sql } from 'drizzle-orm'
import { FixtureServer, longHtml, rss } from '../../../packages/ingest/test/fixture-server'
import { type JobQueues, KINDS } from '../src/kinds'
import { cycle, type PortableContext } from '../src/portable'
import {
  FIRST_CHUNK_TOKENS,
  type TranslationChunk,
  type TranslationObject,
} from '../src/translation/body'

const NOW = Date.UTC(2026, 8, 4, 10)
const MIN = 60_000
const http = createHttpClient({
  userAgent: 'TelaTest/1.0',
  politenessMs: 0,
  allowPrivateHosts: true,
  timeoutMs: 300,
})

let server: FixtureServer
let db: TelaDb
let blobs: ReturnType<typeof memoryBlobs>
let clock: ReturnType<typeof fakeClock>
let calls: TranslationRequest[]

beforeAll(async () => {
  server = await FixtureServer.start()
})
afterAll(async () => {
  await server.stop()
})
beforeEach(async () => {
  server.reset()
  db = (await createTestDb()).db
  blobs = memoryBlobs()
  clock = fakeClock(NOW)
  calls = []
})

function context(extra: Partial<PortableContext> = {}): PortableContext {
  return {
    db,
    blobs,
    http,
    clock,
    random: () => 0.5,
    jobs: memoryJobs<JobQueues>(),
    translator: createMockTranslator({ calls }),
    ...extra,
  }
}

function feed(titles: string[], paragraphs = 3) {
  return rss({
    link: server.url('/'),
    items: titles.map((title, i) => ({
      guid: `p${i + 1}`,
      link: server.url(`/posts/${i + 1}`),
      title,
      description: `Summary of ${title}`,
      content: longHtml(paragraphs),
      date: `Thu, 0${i + 1} Sep 2026 08:00:00 GMT`,
    })),
  })
}

async function ingest(ctx: PortableContext, body: string) {
  server.text('/feed.xml', body)
  await registerFeed(db, { feedUrl: server.url('/feed.xml'), now: clock.now() })
  // Fetch only: without a translator the translation kinds are disabled.
  const { translator: _translator, ...fetchOnly } = ctx
  await cycle(fetchOnly)
}

async function addReader(id = 'reader') {
  await addTestUser(db, id)
}

/**
 * What the API will do when a reader asks: a requested row and a reservation. Asking again after
 * a failure resets the row, as the API's upsert does.
 */
async function request(articleId: number, lang: string, reserved = 20_000, userId = 'reader') {
  const article = await first<{ content_key: string }>(
    db,
    sql`select content_key from articles where id = ${articleId}`,
  )
  const day = utcDay(clock.now())
  await db.batch([
    db.run(sql`
      insert into body_translations (content_key, lang, state, request_id, requested_by, reserved_tokens, reserved_day, updated_at)
      values (${article?.content_key}, ${lang}, 'requested', 'r1', ${userId}, ${reserved}, ${day}, ${clock.now()})
      on conflict (content_key, lang) do update set
        state = 'requested', request_id = 'r2', requested_by = excluded.requested_by,
        reserved_tokens = excluded.reserved_tokens, reserved_day = excluded.reserved_day,
        used_tokens = 0, chunk_keys = '[]', object_key = null, failed_leaves = '[]',
        updated_at = excluded.updated_at
      where body_translations.state in ('failed', 'skipped')
    `),
    db.run(sql`
      insert into usage_daily (subject, day, reserved, used) values (${userId}, ${day}, ${reserved}, 0)
      on conflict (subject, day) do update set reserved = reserved + excluded.reserved
    `),
  ])
  return article!.content_key
}

const ledger = (subject = 'reader') =>
  first<{ reserved: number; used: number }>(
    db,
    sql`select reserved, used from usage_daily where subject = ${subject}`,
  )

const bodyRow = (key: string, lang = 'zh-Hans') =>
  first<{
    state: string
    chunk_keys: string
    object_key: string | null
    failed_leaves: string
    used_tokens: number
  }>(db, sql`select * from body_translations where content_key = ${key} and lang = ${lang}`)

describe('titles', () => {
  test('are translated into every launch language the article is not in, then left alone', async () => {
    const ctx = context()
    await ingest(ctx, feed(['Post one', 'Post two']))
    await cycle(ctx)
    const titles = await db.all<{
      article_id: number
      lang: string
      title: string
      status: string
    }>(sql`select article_id, lang, title, status from article_titles order by article_id, lang`)
    // The mock prefixes what it writes with the language it was asked for: the Traditional title
    // is the Simplified one converted, and the model was never asked for Traditional.
    expect(titles).toEqual([
      { article_id: 1, lang: 'fr', title: 'fr:Post one', status: 'done' },
      { article_id: 1, lang: 'zh-Hans', title: 'zh-Hans:Post one', status: 'done' },
      { article_id: 1, lang: 'zh-Hant', title: 'zh-Hans:Post one', status: 'done' },
      { article_id: 2, lang: 'fr', title: 'fr:Post two', status: 'done' },
      { article_id: 2, lang: 'zh-Hans', title: 'zh-Hans:Post two', status: 'done' },
      { article_id: 2, lang: 'zh-Hant', title: 'zh-Hans:Post two', status: 'done' },
    ])
    expect(calls.map((c) => c.targetLang)).toEqual(['zh-Hans', 'fr'])
    const spent = await first<{ used: number }>(
      db,
      sql`select used from usage_daily where subject = '*'`,
    )
    expect(spent?.used).toBeGreaterThan(0)
    // Nothing stale: the next cycle translates nothing.
    calls.length = 0
    clock.advance(MIN)
    await cycle(ctx)
    expect(calls).toHaveLength(0)
  })

  test('an edited title makes its translation due again', async () => {
    const ctx = context()
    await ingest(ctx, feed(['Post one'], 3))
    await cycle(ctx)
    server.text('/feed.xml', feed(['Post one, revised'], 4))
    await db.run(sql`update feeds set next_fetch_at = 0`)
    clock.advance(MIN)
    await cycle(ctx) // fetch the edit, then its title
    clock.advance(MIN)
    await cycle(ctx)
    expect(
      await db.all(sql`select lang, title from article_titles where article_id = 1 order by lang`),
    ).toEqual([
      { lang: 'fr', title: 'fr:Post one, revised' },
      { lang: 'zh-Hans', title: 'zh-Hans:Post one, revised' },
      { lang: 'zh-Hant', title: 'zh-Hans:Post one, revised' },
    ])
  })

  test('a job still holding a feed that merged away files its titles under the feed the posts joined', async () => {
    // The job is leased on feed 1's key; while its call is out, feed 1 merges into feed 2 and the
    // post moves across (ADR 0028). Feed 2's readers find titles by feed_id.
    const mock = createMockTranslator({ calls })
    let merged = false
    const merging: Translator = {
      model: mock.model,
      async translate(request) {
        if (!merged) {
          merged = true
          await db.batch([
            bumpSeq(db),
            ...mergeFeed(db, { alias: 1, target: 2, move: [1], carry: [] }, clock.now()),
          ] as never)
        }
        return mock.translate(request)
      },
    }
    const ctx = context({ translator: merging })
    await ingest(ctx, feed(['Post one']))
    await db.run(sql`
      insert into feeds (site_id, feed_url, host, next_fetch_at, created_at, updated_at)
      values (1, ${server.url('/other.xml')}, 'other.example', ${NOW + 60 * MIN}, 0, 0)
    `)
    await cycle(ctx)
    expect(merged).toBe(true)
    expect(
      await db.all(sql`select lang, feed_id as "feedId", status from article_titles order by lang`),
    ).toEqual([
      { lang: 'fr', feedId: 2, status: 'done' },
      { lang: 'zh-Hans', feedId: 2, status: 'done' },
      { lang: 'zh-Hant', feedId: 2, status: 'done' },
    ])
  })

  test('stop once the background budget for the day is spent', async () => {
    const ctx = context({ backgroundBudget: 10 })
    await ingest(ctx, feed(['Post one']))
    await db.run(sql`insert into usage_daily (subject, day, used) values ('*', ${utcDay(NOW)}, 10)`)
    await cycle(ctx)
    expect(calls).toHaveLength(0)
    expect(await db.all(sql`select 1 from article_titles`)).toHaveLength(0)
  })
})

describe('titles, batched by feed', () => {
  function manyPosts(n: number) {
    return rss({
      link: server.url('/'),
      items: Array.from({ length: n }, (_, i) => ({
        guid: `p${i + 1}`,
        link: server.url(`/posts/${i + 1}`),
        title: `Post ${i + 1}`,
        description: `Summary of post ${i + 1}`,
        content: longHtml(3),
      })),
    })
  }

  test('share one call per language: the prompt is paid once, not once an article', async () => {
    const ctx = context()
    await ingest(ctx, manyPosts(5))
    await cycle(ctx)
    // English posts: Simplified and French are asked for, and Traditional rides on Simplified.
    expect(calls.map((c) => c.targetLang)).toEqual(['zh-Hans', 'fr'])
    for (const call of calls) expect(call.blocks).toHaveLength(10) // five titles, five excerpts
    const rows = await db.all<{ lang: string; n: number }>(
      sql`select lang, count(*) as n from article_titles where status = 'done' group by lang order by lang`,
    )
    expect(rows).toEqual([
      { lang: 'fr', n: 5 },
      { lang: 'zh-Hans', n: 5 },
      { lang: 'zh-Hant', n: 5 },
    ])
    const logged = await db.all<{ target_lang: string }>(
      sql`select target_lang from llm_calls where job = 'translate.title' order by id`,
    )
    expect(logged).toEqual([{ target_lang: 'zh-Hans' }, { target_lang: 'fr' }])
  })

  test('a backlog larger than one job finishes over the next ticks', async () => {
    const ctx = context()
    await ingest(ctx, manyPosts(TITLES_PER_JOB + 5))
    await cycle(ctx)
    // Every post written gets a row in each of the three languages it is not in.
    const count = async () =>
      (await first<{ n: number }>(db, sql`select count(*) as n from article_titles`))?.n ?? 0
    expect(await count()).toBe(TITLES_PER_JOB * 3)
    clock.advance(MIN)
    await cycle(ctx)
    expect(await count()).toBe((TITLES_PER_JOB + 5) * 3)
    // Two jobs, each a Simplified call and a French one.
    expect(calls.map((c) => c.targetLang)).toEqual(['zh-Hans', 'fr', 'zh-Hans', 'fr'])
  })

  test('a provider failure in one language keeps what the others made, and backs off', async () => {
    // Japanese posts need every launch language; English is refused for a while.
    let refuseEnglish = true
    const mock = createMockTranslator({ calls })
    const flaky: Translator = {
      model: mock.model,
      async translate(request) {
        if (refuseEnglish && request.targetLang === 'en') throw new Error('HTTP 503')
        return mock.translate(request)
      },
    }
    const ctx = context({ translator: flaky })
    await ingest(ctx, manyPosts(3))
    await db.run(sql`update articles set source_lang = 'ja'`)
    const { outcomes } = await cycle(ctx)
    expect(outcomes).toMatchObject([{ status: 'retrying', error: 'HTTP 503' }])
    const made = await db.all<{ lang: string; n: number }>(
      sql`select lang, count(*) as n from article_titles group by lang order by lang`,
    )
    expect(made).toEqual([
      { lang: 'fr', n: 3 },
      { lang: 'zh-Hans', n: 3 },
      { lang: 'zh-Hant', n: 3 },
    ])
    const spent = await first<{ used: number }>(
      db,
      sql`select used from usage_daily where subject = '*'`,
    )
    expect(spent?.used).toBeGreaterThan(0)
    // Past the backoff, with the provider back: only English is asked for.
    refuseEnglish = false
    calls.length = 0
    clock.advance(6 * MIN)
    await cycle(ctx)
    expect(calls.map((c) => c.targetLang)).toEqual(['en'])
    const all = await db.all<{ lang: string; n: number }>(
      sql`select lang, count(*) as n from article_titles where status = 'done' group by lang order by lang`,
    )
    expect(all).toEqual([
      { lang: 'en', n: 3 },
      { lang: 'fr', n: 3 },
      { lang: 'zh-Hans', n: 3 },
      { lang: 'zh-Hant', n: 3 },
    ])
  })

  /**
   * Four posts in two source languages: five (target, source) groups, a call each. Japanese posts
   * need Simplified (Traditional rides on it), English and French; French ones Simplified and
   * English.
   */
  async function twoSourceLanguages(ctx: PortableContext) {
    await ingest(ctx, manyPosts(4))
    await db.run(
      sql`update articles set source_lang = case when id % 2 = 1 then 'ja' else 'fr' end`,
    )
  }

  test('a feed whose calls outlast one lease commits each group as it lands', async () => {
    // Every model call takes 80 s of the fake clock: the five groups take 400 s, past the
    // 5-minute lease the whole feed once had to fit in.
    const slow: Translator = {
      model: 'slow-mock',
      async translate(request) {
        clock.advance(80_000)
        return createMockTranslator({ calls }).translate(request)
      },
    }
    const ctx = context({ translator: slow })
    await twoSourceLanguages(ctx)
    const { outcomes } = await cycle(ctx)
    expect(outcomes).toMatchObject([{ status: 'done' }])
    expect(calls).toHaveLength(5)
    const rows = await db.all<{ status: string; n: number }>(
      sql`select status, count(*) as n from article_titles group by status`,
    )
    // Two Japanese posts in four languages, two French ones in three.
    expect(rows).toEqual([{ status: 'done', n: 14 }])
    expect(await db.all(sql`select key from leases where kind = 'translate.title'`)).toEqual([])
  })

  test('a lease lost between groups keeps the groups committed before it', async () => {
    // Groups run zh-Hans←ja, en←ja, fr←ja, zh-Hans←fr, en←fr. During the third call the lease
    // lapses and another holder could take it: nothing more is written, and what the first two
    // groups paid for stays, the Traditional titles the first made included.
    const mock = createMockTranslator({ calls })
    let lapsed = false
    const takenOver: Translator = {
      model: mock.model,
      async translate(request) {
        if (calls.length === 2 && !lapsed) {
          lapsed = true
          await db.run(sql`update leases set until = 0 where kind = 'translate.title'`)
        }
        return mock.translate(request)
      },
    }
    const ctx = context({ translator: takenOver })
    await twoSourceLanguages(ctx)
    const { outcomes } = await cycle(ctx)
    expect(outcomes).toMatchObject([{ status: 'lost' }])
    expect(calls).toHaveLength(3)
    const kept = await db.all<{ source_lang: string; n: number }>(sql`
      select a.source_lang, count(*) as n from article_titles t
      join articles a on a.id = t.article_id where t.status = 'done' group by a.source_lang
    `)
    expect(kept).toEqual([{ source_lang: 'ja', n: 6 }])
    // The next holder asks only for what was not committed.
    calls.length = 0
    clock.advance(MIN)
    await cycle(ctx)
    expect(calls.map((c) => `${c.targetLang}←${c.sourceLang}`)).toEqual([
      'fr←ja',
      'zh-Hans←fr',
      'en←fr',
    ])
    const all = await first<{ n: number }>(
      db,
      sql`select count(*) as n from article_titles where status = 'done'`,
    )
    expect(all?.n).toBe(14)
  })

  test('a lease lost between the calls of one group pays for no more of them', async () => {
    // The reply leaves out the title, so the group makes a strict retry call after its first;
    // the lease lapses during that first call.
    const mock = createMockTranslator({ calls, dropIds: new Set(['t1']) })
    const takenOver: Translator = {
      model: mock.model,
      async translate(request) {
        await db.run(sql`update leases set until = 0 where kind = 'translate.title'`)
        return mock.translate(request)
      },
    }
    const ctx = context({ translator: takenOver })
    await ingest(ctx, manyPosts(1))
    const { outcomes } = await cycle(ctx)
    expect(outcomes).toContainEqual({ status: 'lost' })
    expect(calls).toHaveLength(1)
  })

  test('a call that failed, with the lease lost meanwhile, is followed by no other', async () => {
    // Found in review: the lease was checked only after a call that succeeded, so a slow failing
    // provider let a holder whose lease had lapsed send the next group's call regardless.
    const failing = createMockTranslator({ calls, fail: true })
    const lapses: Translator = {
      model: failing.model,
      async translate(request) {
        await db.run(sql`update leases set until = 0 where kind = 'translate.title'`)
        return failing.translate(request)
      },
    }
    const ctx = context({ translator: lapses })
    await twoSourceLanguages(ctx)
    const { outcomes } = await cycle(ctx)
    expect(outcomes).toContainEqual({ status: 'lost' })
    expect(calls).toHaveLength(1)
  })

  test('a batch that keeps failing is recorded failed, stamped for sync, and asked for no more', async () => {
    const ctx = context({ translator: createMockTranslator({ calls, fail: true }) })
    await ingest(ctx, manyPosts(2))
    for (let i = 0; i < 4; i++) {
      await cycle(ctx)
      clock.advance(6 * 60 * MIN)
    }
    const rows = await db.all<{ status: string; seq: number }>(
      sql`select status, seq from article_titles`,
    )
    // Two posts, each failed in the three languages it is not in.
    expect(rows.map((r) => r.status)).toEqual(Array(6).fill('failed'))
    expect(rows[0]?.seq).toBe(await headSeq(db))
    expect(await db.all(sql`select kind, key from dead_letters`)).toEqual([
      { kind: 'translate.title', key: '1' },
    ])
    calls.length = 0
    await cycle(ctx)
    expect(calls).toHaveLength(0)
  })
})

describe('bodies', () => {
  test('stream in chunks, the first one small, then settle into a finished object', async () => {
    const ctx = context()
    await addReader()
    await ingest(ctx, feed(['A long post'], 20))
    const key = await request(1, 'zh-Hans')
    await db.run(sql`delete from leases`)
    calls.length = 0
    const { outcomes } = await cycle(ctx)
    const body = outcomes.find(
      (o) => o.status === 'done' && (o as { result: { chunks?: number } }).result.chunks,
    )
    expect(body).toBeDefined()

    const row = await bodyRow(key)
    expect(row?.state).toBe('done')
    const chunks = JSON.parse(row!.chunk_keys) as string[]
    expect(chunks.length).toBeGreaterThan(1)
    // The first call carried a small opening chunk, so the first paragraphs arrive in seconds.
    const bodyCalls = calls.filter((c) => c.blocks.some((b) => b.text.includes('Paragraph')))
    const firstTokens = bodyCalls[0]!.blocks.reduce((n, b) => n + estimateTokens(b.text), 0)
    expect(firstTokens).toBeLessThan(FIRST_CHUNK_TOKENS * 2)
    const firstChunk = JSON.parse(await (await blobs.get(chunks[0]!))!.text()) as TranslationChunk
    expect(Object.values(firstChunk.blocks).join('')).toContain('zh-Hans:')

    const final = JSON.parse(await (await blobs.get(row!.object_key!))!.text()) as TranslationObject
    const source = JSON.parse(await (await blobs.get(`c/${key}.json`))!.text()) as {
      blocks: unknown[]
    }
    expect(final.status).toBe('done')
    expect(final.blocks).toHaveLength(source.blocks.length)
    // The mock prefixes each text segment: every block came back translated, the last one included.
    expect(final.blocks.every((b) => b.includes('zh-Hans:'))).toBe(true)
    expect(final.blocks.at(-1)).toContain('Paragraph 20.')

    // The reservation is replaced by what was actually spent.
    const ledger = await first<{ reserved: number; used: number }>(
      db,
      sql`select reserved, used from usage_daily where subject = 'reader'`,
    )
    expect(ledger).toEqual({ reserved: 0, used: row!.used_tokens })
  })

  test('reuse the shared cache: a second article with the same paragraphs costs no call', async () => {
    const ctx = context()
    await addReader()
    await ingest(ctx, feed(['First', 'Second'], 4))
    const key1 = await request(1, 'zh-Hans')
    await cycle(ctx)
    expect((await bodyRow(key1))?.state).toBe('done')
    // Same body, different article: the content object, and so its translation, is shared.
    expect(await contentKeyOf(2)).toBe(key1)
  })

  test('a block the model drops renders as source, and the translation says partial', async () => {
    const ctx = context({ translator: createMockTranslator({ dropMarker: 'Paragraph 2.', calls }) })
    await addReader()
    await ingest(ctx, feed(['Post'], 4))
    const key = await request(1, 'zh-Hans')
    await cycle(ctx)
    const row = await bodyRow(key)
    expect(row?.state).toBe('partial')
    expect(JSON.parse(row!.failed_leaves)).toHaveLength(1)
    const final = JSON.parse(await (await blobs.get(row!.object_key!))!.text()) as TranslationObject
    expect(final.blocks.join('')).toContain('Paragraph 2.')
    expect(final.blocks.join('')).not.toContain('zh-Hans:Paragraph 2.')
  })

  test('an execution that runs out of time is continued by the next tick, without re-translating', async () => {
    // Every model call takes three minutes of the fake clock, inside the 4-minute hold a chunk
    // extends the lease by: a 10-minute execution fits four calls, and this article needs more.
    const slow: Translator = {
      model: 'slow-mock',
      async translate(request) {
        clock.advance(3 * MIN)
        return createMockTranslator({ calls }).translate(request)
      },
    }
    const ctx = context({ translator: slow })
    await addReader()
    await ingest(ctx, feed(['A very long post'], 400))
    const key = await request(1, 'zh-Hans', 100_000)
    await cycle(ctx)
    const midway = await bodyRow(key)
    expect(midway?.state).toBe('running')
    const firstRun = calls.length
    expect(firstRun).toBeGreaterThan(0)

    for (let i = 0; i < 10 && (await bodyRow(key))?.state === 'running'; i++) {
      clock.advance(MIN)
      await cycle(ctx)
    }
    const done = await bodyRow(key)
    expect(done?.state).toBe('done')
    // Every leaf was sent to the model exactly once across the executions.
    const sent = calls.flatMap((c) => c.blocks.map((b) => b.id))
    expect(new Set(sent).size).toBe(sent.length)
  })

  test('a holder whose lease was taken over writes nothing more', async () => {
    const ctx = context()
    await addReader()
    await ingest(ctx, feed(['Post'], 12))
    const key = await request(1, 'zh-Hans')
    // Claim, then let the claim lapse and another worker take it before the first one runs.
    const { tick } = await import('../src/runner')
    await tick(ctx)
    const [stale] = ctx.jobs.take('translate')
    clock.advance(10 * MIN)
    await tick(ctx)
    const { runJob } = await import('../src/runner')
    expect(await runJob(ctx, stale!)).toEqual({ status: 'lost' })
    expect((await bodyRow(key))?.chunk_keys).toBe('[]')
  })

  test('a message delivered twice at once starts once: every leaf is paid for once', async () => {
    const ctx = context()
    await addReader()
    await ingest(ctx, feed(['Post'], 12))
    const key = await request(1, 'zh-Hans')
    const { tick, runJob } = await import('../src/runner')
    await tick(ctx)
    const [message] = ctx.jobs.take('translate')
    calls.length = 0
    // Queues deliver at least once: two consumers run the same message side by side.
    const outcomes = await Promise.all([runJob(ctx, message!), runJob(ctx, message!)])
    expect(outcomes.map((o) => o.status).sort()).toEqual(['done', 'lost'])
    const row = await bodyRow(key)
    expect(row?.state).toBe('done')
    const sent = calls.flatMap((c) => c.blocks.map((b) => b.id))
    expect(sent.length).toBeGreaterThan(0)
    expect(new Set(sent).size).toBe(sent.length)
    const chunks = JSON.parse(row!.chunk_keys) as string[]
    expect(new Set(chunks).size).toBe(chunks.length)
  })
})

describe('a body translation that fails', () => {
  test('by exhaustion gives its reservation back and charges what its chunks spent', async () => {
    // The opening chunk translates; every later body call fails, until the attempts run out.
    let bodyCalls = 0
    const mock = createMockTranslator({ calls })
    const failing: Translator = {
      model: mock.model,
      async translate(request) {
        const body = request.blocks.some((b) => b.text.includes('Paragraph'))
        if (body && ++bodyCalls > 1) throw new Error('HTTP 503')
        return mock.translate(request)
      },
    }
    const ctx = context({ translator: failing })
    await addReader()
    await ingest(ctx, feed(['A long post'], 20))
    const key = await request(1, 'zh-Hans', 20_000)
    for (let i = 0; i < 3; i++) {
      await cycle(ctx)
      clock.advance(5 * MIN)
    }
    const row = await bodyRow(key)
    expect(row?.state).toBe('failed')
    expect(row!.used_tokens).toBeGreaterThan(0)
    expect(await db.all(sql`select kind from dead_letters`)).toEqual([{ kind: 'translate.body' }])
    expect(await ledger()).toEqual({ reserved: 0, used: row!.used_tokens })

    // The reader asks again: only the new reservation is held, not the old one beside it.
    await request(1, 'zh-Hans', 20_000)
    expect(await ledger()).toEqual({ reserved: 20_000, used: row!.used_tokens })
  })

  test('reported, as a missing content object, gives its reservation back', async () => {
    const ctx = context()
    await addReader()
    await ingest(ctx, feed(['Post'], 4))
    const key = await request(1, 'zh-Hans', 20_000)
    await blobs.delete(`c/${key}.json`)
    await cycle(ctx)
    expect((await bodyRow(key))?.state).toBe('failed')
    expect(await ledger()).toEqual({ reserved: 0, used: 0 })
  })

  test('by starts that all died gives its reservation back when the tick retires it', async () => {
    const ctx = context()
    await addReader()
    await ingest(ctx, feed(['Post'], 4))
    const key = await request(1, 'zh-Hans', 20_000)
    const { tick } = await import('../src/runner')
    const spec = KINDS['translate.body']!
    for (let attempt = 1; attempt <= spec.backoff.maxAttempts; attempt++) {
      await tick(ctx)
      const [message] = ctx.jobs.take('translate')
      // runJob starts the attempt, then the invocation is killed: no result, no failLease.
      const runOwner = `${message!.owner}>killed`
      expect((await startLease(db, message!, runOwner, clock.now(), spec.ttlMs))?.attempts).toBe(
        attempt,
      )
      clock.advance(spec.ttlMs + MIN)
    }
    await tick(ctx)
    expect(ctx.jobs.take('translate')).toEqual([])
    expect((await bodyRow(key))?.state).toBe('failed')
    expect(await ledger()).toEqual({ reserved: 0, used: 0 })
  })
})

describe('Traditional Chinese', () => {
  /**
   * The mock, writing Simplified Chinese that conversion visibly changes: every text segment it
   * prefixes with `zh-Hans:` also gets 软件, which Taiwan phrasing writes 軟體.
   */
  function writesChinese(): Translator {
    const mock = createMockTranslator({ calls })
    return {
      model: mock.model,
      async translate(request) {
        const response = await mock.translate(request)
        return {
          ...response,
          translations: response.translations.map((t) => ({
            id: t.id,
            text: t.text.replaceAll('zh-Hans:', 'zh-Hans:软件 '),
          })),
        }
      },
    }
  }

  /** One post written in Chinese, markup included, long enough to be a full article. */
  function chinesePost(title: string, sentence: string) {
    const paragraph = (i: number) =>
      `<p>${sentence.repeat(8)}<a href="https://example.com/${i}">${sentence}</a><code>a &lt; b</code>${i}</p>`
    return rss({
      link: server.url('/'),
      items: [
        {
          guid: 'p1',
          link: server.url('/posts/1'),
          title,
          content: Array.from({ length: 6 }, (_, i) => paragraph(i + 1)).join(''),
          date: 'Thu, 01 Sep 2026 08:00:00 GMT',
        },
      ],
    })
  }

  const titlesOf = (lang: string) =>
    db.all<{ article_id: number; title: string | null; status: string; model: string | null }>(
      sql`select article_id, title, status, model from article_titles where lang = ${lang}
        order by article_id`,
    )
  const cacheLangs = async () =>
    (
      await db.all<{ target_lang: string }>(
        sql`select distinct target_lang from block_translations order by target_lang`,
      )
    ).map((r) => r.target_lang)
  const loggedLangs = async (job: string) =>
    (
      await db.all<{ target_lang: string }>(
        sql`select distinct target_lang from llm_calls where job = ${job} order by target_lang`,
      )
    ).map((r) => r.target_lang)

  test('an English post: two calls, and the Traditional title is the Simplified one converted', async () => {
    const ctx = context({ translator: writesChinese() })
    await ingest(ctx, feed(['Post one']))
    await cycle(ctx)
    expect(calls.map((c) => c.targetLang)).toEqual(['zh-Hans', 'fr'])
    expect(await titlesOf('zh-Hans')).toEqual([
      { article_id: 1, title: 'zh-Hans:软件 Post one', status: 'done', model: 'mock' },
    ])
    expect(await titlesOf('zh-Hant')).toEqual([
      { article_id: 1, title: 'zh-Hans:軟體 Post one', status: 'done', model: 'mock' },
    ])
    expect(await loggedLangs('translate.title')).toEqual(['fr', 'zh-Hans'])
    // The cache keeps what the model wrote; Traditional is converted from it as it is read.
    expect(await cacheLangs()).toEqual(['fr', 'zh-Hans'])
  })

  test('a Simplified post is asked of the model in English and French only', async () => {
    const ctx = context()
    await ingest(ctx, chinesePost('我们的软件和视频信息', '我们这个软件的视频信息很好。'))
    expect(
      await first<{ sourceLang: string }>(
        db,
        sql`select source_lang as "sourceLang" from articles where id = 1`,
      ),
    ).toEqual({ sourceLang: 'zh-Hans' })
    await cycle(ctx)
    expect(calls.map((c) => `${c.targetLang}←${c.sourceLang}`)).toEqual([
      'en←zh-Hans',
      'fr←zh-Hans',
    ])
    expect(await titlesOf('zh-Hant')).toEqual([
      { article_id: 1, title: '我們的軟體和影片資訊', status: 'done', model: 'opencc:twp' },
    ])
    const excerpt = await first<{ excerpt: string }>(
      db,
      sql`select excerpt from article_titles where lang = 'zh-Hant'`,
    )
    expect(excerpt?.excerpt).toStartWith('我們這個軟體的影片資訊很好。')
    expect(await loggedLangs('translate.title')).toEqual(['en', 'fr'])
    expect(await cacheLangs()).toEqual(['en', 'fr'])
  })

  test('a Traditional post gets its Simplified title by conversion', async () => {
    const ctx = context()
    await ingest(ctx, chinesePost('我們的軟體和影片資訊', '我們這個軟體的影片資訊很好。'))
    expect(
      await first<{ sourceLang: string }>(
        db,
        sql`select source_lang as "sourceLang" from articles where id = 1`,
      ),
    ).toEqual({ sourceLang: 'zh-Hant' })
    await cycle(ctx)
    expect(calls.map((c) => `${c.targetLang}←${c.sourceLang}`)).toEqual([
      'en←zh-Hant',
      'fr←zh-Hant',
    ])
    expect(await titlesOf('zh-Hans')).toEqual([
      { article_id: 1, title: '我们的软件和视频信息', status: 'done', model: 'opencc:cn' },
    ])
  })

  test('a Traditional title follows a standing Simplified one, echo and failure included, with no call', async () => {
    // What every post already translated when Traditional became a reading language looks like:
    // a Simplified row from the current title, and no Traditional one.
    const ctx = context()
    await ingest(ctx, feed(['Post one', 'Post two', 'Post three']))
    await cycle(ctx)
    await db.run(sql`delete from article_titles where lang = 'zh-Hant'`)
    await db.run(sql`update article_titles set title = '软件', excerpt = '视频信息'
      where lang = 'zh-Hans' and article_id = 1`)
    await db.run(sql`update article_titles set title = '软件 0.7.1', status = 'echo'
      where lang = 'zh-Hans' and article_id = 2`)
    await db.run(sql`update article_titles set title = null, excerpt = null, status = 'failed'
      where lang = 'zh-Hans' and article_id = 3`)
    calls.length = 0
    clock.advance(MIN)
    await cycle(ctx)
    expect(calls).toEqual([])
    expect(await titlesOf('zh-Hant')).toEqual([
      { article_id: 1, title: '軟體', status: 'done', model: 'mock' },
      { article_id: 2, title: '軟體 0.7.1', status: 'echo', model: 'mock' },
      { article_id: 3, title: null, status: 'failed', model: 'mock' },
    ])
    expect(
      await first<{ excerpt: string }>(
        db,
        sql`select excerpt from article_titles where lang = 'zh-Hant' and article_id = 1`,
      ),
    ).toEqual({ excerpt: '影片資訊' })
    // Nothing is due any more.
    clock.advance(MIN)
    await cycle(ctx)
    expect(calls).toEqual([])
  })

  test('a provider refusing Simplified still lets a standing Simplified title be converted', async () => {
    // Post one as on the day this deploys (a current Simplified title, no Traditional one), post
    // two retitled since: both are in one (Simplified, English) group. A provider that keeps
    // refusing must not take post one's free conversion down with post two's call, or the
    // kind's exhaustion would record it failed.
    const ctx = context({ translator: writesChinese() })
    await ingest(ctx, feed(['Post one', 'Post two']))
    await cycle(ctx)
    await db.run(sql`delete from article_titles where lang = 'zh-Hant'`)
    await db.run(sql`update articles set title_hash = 'retitled' where id = 2`)
    // Nothing cached either, so post two's title needs the model again.
    await db.run(sql`delete from block_translations`)
    const inner = writesChinese()
    const refusing: Translator = {
      model: inner.model,
      async translate(request) {
        if (request.targetLang === 'zh-Hans') throw new Error('HTTP 503')
        return inner.translate(request)
      },
    }
    calls.length = 0
    clock.advance(MIN)
    await cycle(context({ translator: refusing }))
    expect(await titlesOf('zh-Hant')).toEqual([
      { article_id: 1, title: 'zh-Hans:軟體 Post one', status: 'done', model: 'mock' },
    ])
    // Post two's Simplified call failed, so its Simplified title is still the old one's and its
    // Traditional title waits with it.
    expect(
      await first<{ hash: string }>(
        db,
        sql`select source_hash as hash from article_titles where article_id = 2 and lang = 'zh-Hans'`,
      ),
    ).not.toEqual({ hash: 'retitled' })
  })

  test('a body for a Traditional reader of an English post is written, and cached, as Simplified', async () => {
    const ctx = context({ translator: writesChinese() })
    await addReader()
    await ingest(ctx, feed(['A post'], 6))
    await cycle(ctx) // titles
    calls.length = 0
    const key = await request(1, 'zh-Hant')
    await cycle(ctx)
    const row = await bodyRow(key, 'zh-Hant')
    expect(row?.state).toBe('done')
    expect(calls.length).toBeGreaterThan(0)
    expect(new Set(calls.map((c) => c.targetLang))).toEqual(new Set(['zh-Hans']))
    expect(await loggedLangs('translate.body')).toEqual(['zh-Hans'])
    const final = JSON.parse(await (await blobs.get(row!.object_key!))!.text()) as TranslationObject
    expect(final.lang).toBe('zh-Hant')
    expect(final.blocks.every((b) => b.includes('zh-Hans:軟體'))).toBe(true)
    expect(final.blocks.join('')).not.toContain('软件')
    expect(await cacheLangs()).toEqual(['fr', 'zh-Hans'])

    // A Simplified reader of the same post pays nothing: every block is a cache hit.
    calls.length = 0
    await request(1, 'zh-Hans', 20_000, 'reader')
    await cycle(ctx)
    const simplified = await bodyRow(key, 'zh-Hans')
    expect(simplified?.state).toBe('done')
    expect(calls).toEqual([])
    expect(simplified?.used_tokens).toBe(0)
    const again = JSON.parse(
      await (await blobs.get(simplified!.object_key!))!.text(),
    ) as TranslationObject
    expect(again.blocks.every((b) => b.includes('zh-Hans:软件'))).toBe(true)
  })

  test('a body in one Chinese script read in the other is converted: no call, no spend', async () => {
    const ctx = context()
    await addReader()
    await ingest(ctx, chinesePost('我们的软件', '我们这个软件的视频信息很好。'))
    await cycle(ctx) // titles
    calls.length = 0
    // tela-api reserves nothing for a conversion.
    const key = await request(1, 'zh-Hant', 0)
    await cycle(ctx)
    const row = await bodyRow(key, 'zh-Hant')
    expect(row?.state).toBe('done')
    expect(calls).toEqual([])
    expect(await db.all(sql`select 1 from llm_calls where job = 'translate.body'`)).toEqual([])
    expect(row?.used_tokens).toBe(0)
    expect(await ledger()).toEqual({ reserved: 0, used: 0 })
    // Streamed like cache hits, a chunk at a time.
    expect((JSON.parse(row!.chunk_keys) as string[]).length).toBeGreaterThan(0)
    const final = JSON.parse(await (await blobs.get(row!.object_key!))!.text()) as TranslationObject
    expect(final).toMatchObject({ status: 'done', model: 'opencc:twp', failedLeaves: [] })
    const html = final.blocks.join('')
    expect(html).toContain('我們這個軟體的影片資訊很好。')
    expect(html).not.toContain('软件')
    // Markup survives: placeholders and entities are ASCII, which OpenCC never touches.
    expect(html).toContain('<a href="https://example.com/1">我們這個軟體的影片資訊很好。</a>')
    expect(html).toContain('<code>a &lt; b</code>')
    expect(await cacheLangs()).toEqual(['en', 'fr'])
    expect(
      await first<{ model: string }>(
        db,
        sql`select model from body_translations where lang = 'zh-Hant'`,
      ),
    ).toEqual({ model: 'opencc:twp' })
  })

  test('and a Traditional body read in Simplified the same way', async () => {
    const ctx = context()
    await addReader()
    await ingest(ctx, chinesePost('我們的軟體', '我們這個軟體的影片資訊很好。'))
    await cycle(ctx) // titles
    calls.length = 0
    const key = await request(1, 'zh-Hans', 0)
    await cycle(ctx)
    expect(calls).toEqual([])
    const row = await bodyRow(key, 'zh-Hans')
    expect(row?.state).toBe('done')
    const final = JSON.parse(await (await blobs.get(row!.object_key!))!.text()) as TranslationObject
    expect(final.model).toBe('opencc:cn')
    expect(final.blocks.join('')).toContain('我们这个软件的视频信息很好。')
  })

  /**
   * tela-api judges a conversion by the article's language, the job by the content object's, and
   * the object is shared by every article with that body, so the two can disagree.
   */
  test("a reader's request that reserved nothing is never paid for, whatever the object says", async () => {
    const ctx = context()
    await addReader()
    await ingest(ctx, feed(['Post'], 4))
    await cycle(ctx) // titles
    calls.length = 0
    // Reserved nothing, as for a conversion, but the stored body is English.
    const key = await request(1, 'zh-Hant', 0)
    await cycle(ctx)
    expect(calls).toEqual([])
    expect(await db.all(sql`select 1 from llm_calls where job = 'translate.body'`)).toEqual([])
    expect((await bodyRow(key, 'zh-Hant'))?.state).toMatch(/failed|partial/)
  })

  test('a body already in the language asked for is settled, not sent to the model', async () => {
    const ctx = context()
    await addReader()
    await ingest(ctx, feed(['Post'], 4))
    await cycle(ctx) // titles
    calls.length = 0
    const key = await request(1, 'en')
    await cycle(ctx)
    expect(calls).toEqual([])
    expect(await bodyRow(key, 'en')).toMatchObject({ state: 'failed' })
    expect(await ledger()).toEqual({ reserved: 0, used: 0 })
  })
})

async function contentKeyOf(articleId: number) {
  return (
    await first<{ content_key: string }>(
      db,
      sql`select content_key from articles where id = ${articleId}`,
    )
  )?.content_key
}

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { first, headSeq, startLease, type TelaDb, TITLES_PER_JOB, utcDay } from '@tela/data'
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
    }>(sql`select article_id, lang, title, status from article_titles order by article_id`)
    expect(titles).toEqual([
      { article_id: 1, lang: 'zh-Hans', title: 'zh-Hans:Post one', status: 'done' },
      { article_id: 2, lang: 'zh-Hans', title: 'zh-Hans:Post two', status: 'done' },
    ])
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
    const title = await first<{ title: string }>(
      db,
      sql`select title from article_titles where article_id = 1`,
    )
    expect(title?.title).toBe('zh-Hans:Post one, revised')
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
    // English posts: zh-Hans is the only other launch language.
    expect(calls).toHaveLength(1)
    expect(calls[0]?.targetLang).toBe('zh-Hans')
    expect(calls[0]?.blocks).toHaveLength(10) // five titles, five excerpts
    const rows = await db.all<{ status: string; n: number }>(
      sql`select status, count(*) as n from article_titles group by status`,
    )
    expect(rows).toEqual([{ status: 'done', n: 5 }])
    const logged = await db.all<{ n: number }>(
      sql`select count(*) as n from llm_calls where job = 'translate.title'`,
    )
    expect(logged).toEqual([{ n: 1 }])
  })

  test('a backlog larger than one job finishes over the next ticks', async () => {
    const ctx = context()
    await ingest(ctx, manyPosts(TITLES_PER_JOB + 5))
    await cycle(ctx)
    const count = async () =>
      (await first<{ n: number }>(db, sql`select count(*) as n from article_titles`))?.n ?? 0
    expect(await count()).toBe(TITLES_PER_JOB)
    clock.advance(MIN)
    await cycle(ctx)
    expect(await count()).toBe(TITLES_PER_JOB + 5)
    expect(calls).toHaveLength(2)
  })

  test('a provider failure in one language keeps what the other made, and backs off', async () => {
    // Japanese posts need both launch languages; English is refused for a while.
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
      sql`select lang, count(*) as n from article_titles group by lang`,
    )
    expect(made).toEqual([{ lang: 'zh-Hans', n: 3 }])
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
      { lang: 'zh-Hans', n: 3 },
    ])
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
    expect(rows.map((r) => r.status)).toEqual(['failed', 'failed'])
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

async function contentKeyOf(articleId: number) {
  return (
    await first<{ content_key: string }>(
      db,
      sql`select content_key from articles where id = ${articleId}`,
    )
  )?.content_key
}

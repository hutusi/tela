import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { processArticleHtml } from '@tela/content'
import {
  articleContents,
  articles,
  articleTranslations,
  feeds,
  llmUsage,
  sites,
  translationRequests,
  translations,
} from '@tela/db'
import { requestBodyTranslation, setTranslationStatus } from '@tela/db/queries'
import { resetDatabase, startTestDb, type TestDb } from '@tela/db/testing'
import { createMockTranslator, type TranslationRequest, type Translator } from '@tela/llm'
import { eq, sql } from 'drizzle-orm'
import { type Job, PgBoss } from 'pg-boss'
import type { WorkerContext } from '../src/context'
import {
  handleTranslateBody,
  handleTranslateTitle,
  secondsUntilNextUtcDay,
} from '../src/jobs/translate'
import { ensureQueues, QUEUES, type TranslateBodyJob, type TranslateTitleJob } from '../src/queues'
import { translateArticleBody } from '../src/translation/translate-body'
import { translateArticleTitle } from '../src/translation/translate-title'

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
})

const HTML = `
  <p>On Calle de Toledo there is a <a href="https://x.example/b">bakery</a> that has been open since 1928.</p>
  <p>The bread has not changed. Around it the city has been dug up, rerouted and renamed.</p>
  <pre><code>let keep = "me"</code></pre>
  <p>The bread has not changed. Around it the city has been dug up, rerouted and renamed.</p>
`

async function seedArticle(
  options: { sourceLang?: string | null; optOut?: boolean; html?: string } = {},
) {
  const [site] = await t.db
    .insert(sites)
    .values({
      homeUrl: 'https://blog.example',
      title: 'Blog',
      translationOptOut: options.optOut ?? false,
    })
    .returning()
  const [feed] = await t.db
    .insert(feeds)
    .values({ siteId: site!.id, feedUrl: 'https://blog.example/feed' })
    .returning()
  const processed = await processArticleHtml({
    html: options.html ?? HTML,
    baseUrl: 'https://blog.example/p/1',
  })
  const [article] = await t.db
    .insert(articles)
    .values({
      feedId: feed!.id,
      dedupKey: 'k1',
      title: 'The bakery that outlived three metro lines',
      excerpt: processed.excerpt,
      sourceLang: options.sourceLang === undefined ? 'en' : options.sourceLang,
      contentHash: processed.contentHash,
    })
    .returning()
  await t.db
    .insert(articleContents)
    .values({ articleId: article!.id, html: processed.html, blocks: processed.blocks })
  return { article: article!, processed }
}

async function seedArticleWithKey(dedupKey: string, title: string): Promise<number> {
  const [feed] = await t.db.select({ id: feeds.id }).from(feeds).limit(1)
  const [article] = await t.db
    .insert(articles)
    .values({ feedId: feed!.id, dedupKey, title, sourceLang: 'en' })
    .returning({ id: articles.id })
  return article!.id
}

describe('translateArticleBody', () => {
  test('translates through the cache, materializes html, and records usage', async () => {
    const { article, processed } = await seedArticle()
    const translator = createMockTranslator()
    const first = await translateArticleBody({ db: t.db, translator }, article.id, 'zh-Hans', {
      onDemand: true,
    })
    expect(first).toMatchObject({ status: 'done', failed: 0, cached: 0 })
    // 3 translatable blocks, two of them identical → 2 cache entries; pre is skipped.
    expect(first.translated).toBe(3)
    expect(await t.db.select().from(translations)).toHaveLength(2)

    const [row] = await t.db
      .select()
      .from(articleTranslations)
      .where(eq(articleTranslations.articleId, article.id))
    expect(row?.status).toBe('done')
    expect(row?.contentHash).toBe(processed.contentHash)
    expect(row?.model).toBe('mock')
    expect(row?.html).toContain('zh-Hans:On Calle de Toledo')
    expect(row?.html).toContain('<a href="https://x.example/b">zh-Hans:bakery</a>')
    expect(row?.html).toContain('let keep = "me"') // pre untouched
    expect(row?.html?.match(/zh-Hans:The bread/g)).toHaveLength(2)
    expect(await t.db.select().from(llmUsage)).toHaveLength(1)

    // Second run: everything is cached, no provider call, no new usage.
    const second = await translateArticleBody({ db: t.db, translator }, article.id, 'zh-Hans', {
      onDemand: true,
    })
    expect(second).toMatchObject({ status: 'done', translated: 0, cached: 3, failed: 0 })
    expect(await t.db.select().from(llmUsage)).toHaveLength(1)
  })

  test('keeps partial results and lists failed blocks', async () => {
    const { article, processed } = await seedArticle()
    const firstId = processed.blocks.find((b) => !b.skip)?.id as string
    const translator = createMockTranslator({ failIds: new Set([firstId]) })
    const out = await translateArticleBody({ db: t.db, translator }, article.id, 'zh-Hans', {
      onDemand: true,
    })
    expect(out.status).toBe('partial')
    expect(out.failed).toBe(1)
    const [row] = await t.db
      .select()
      .from(articleTranslations)
      .where(eq(articleTranslations.articleId, article.id))
    expect(row?.status).toBe('partial')
    expect(row?.failedBlockIds).toEqual([firstId])
    // The failed block keeps its source text in the materialized html.
    expect(row?.html).toContain(
      'On Calle de Toledo there is a <a href="https://x.example/b">bakery</a>',
    )
  })

  test('marks failed, clears any earlier html, and rethrows when the provider is down', async () => {
    const { article } = await seedArticle()
    // A translation of an earlier content version must not survive as if it were current.
    await setTranslationStatus(t.db, article.id, 'zh-Hans', 'done', {
      html: '<p>old</p>',
      contentHash: 'previous-version',
    })
    await expect(
      translateArticleBody(
        { db: t.db, translator: createMockTranslator({ fail: true }) },
        article.id,
        'zh-Hans',
        { onDemand: true },
      ),
    ).rejects.toThrow(/mock provider failure/)
    const [row] = await t.db
      .select()
      .from(articleTranslations)
      .where(eq(articleTranslations.articleId, article.id))
    expect(row?.status).toBe('failed')
    expect(row?.html).toBeNull()
  })

  test('skips same-language articles and opted-out sites', async () => {
    const same = await seedArticle({ sourceLang: 'zh-Hans' })
    expect(
      await translateArticleBody(
        { db: t.db, translator: createMockTranslator() },
        same.article.id,
        'zh-Hans',
      ),
    ).toMatchObject({
      status: 'skipped',
      reason: 'same language',
    })
    await resetDatabase(t.db)
    const opted = await seedArticle({ optOut: true })
    expect(
      await translateArticleBody(
        { db: t.db, translator: createMockTranslator() },
        opted.article.id,
        'zh-Hans',
      ),
    ).toMatchObject({
      status: 'failed',
      reason: 'site opted out of translation',
    })
  })

  test('a body past the per-article ceiling ends partial, with progress stored per chunk', async () => {
    const html = Array.from(
      { length: 12 },
      (_, i) =>
        `<p>Paragraph ${i + 1}: the bakery on Calle de Toledo has been selling the same loaf since 1928, and the neighbourhood has been rebuilt around it more than once.</p>`,
    ).join('')
    const { article } = await seedArticle({ html })
    const calls: TranslationRequest[] = []
    const deps = { db: t.db, translator: createMockTranslator({ calls }), maxArticleTokens: 120 }
    const out = await translateArticleBody(deps, article.id, 'zh-Hans', { onDemand: true })
    expect(out.status).toBe('partial')
    expect(out.translated).toBeGreaterThan(0)
    expect(out.failed).toBeGreaterThan(0)
    expect(out.translated + out.failed).toBe(12)
    // Only the accepted prefix went to the model, in one chunk; its usage row is already there.
    expect(calls).toHaveLength(1)
    expect(calls[0]?.blocks).toHaveLength(out.translated)
    expect(await t.db.select().from(llmUsage)).toHaveLength(1)
    expect(await t.db.select().from(translations)).toHaveLength(out.translated)
    const [row] = await t.db
      .select()
      .from(articleTranslations)
      .where(eq(articleTranslations.articleId, article.id))
    expect(row?.failedBlockIds).toHaveLength(out.failed)
    expect(row?.html).toContain('zh-Hans:Paragraph 1')
    expect(row?.html).toContain('Paragraph 12: the bakery')
    expect(row?.html).not.toContain('zh-Hans:Paragraph 12')

    // A rerun translates nothing new: the stored prefix is served from the cache.
    const again = await translateArticleBody(deps, article.id, 'zh-Hans', { onDemand: true })
    expect(again).toMatchObject({ status: 'partial', translated: 0, cached: out.translated })
    expect(calls).toHaveLength(1)
  })

  test('an attempt is bound to the content and the reservation it was requested with', async () => {
    const userA = '11111111-1111-4111-8111-111111111111'
    await t.db.execute(sql`insert into auth.users (id, email) values (${userA}, 'a@x.test')`)
    const { article } = await seedArticle()
    // Smaller than the seed body, so the second block already falls past the reservation.
    const reservation = { requestedBy: userA, reserveTokens: 30, allowanceTokens: 400_000 }
    expect(
      await requestBodyTranslation(
        t.db,
        article.id,
        'zh-Hans',
        'stale-hash',
        undefined,
        reservation,
      ),
    ).toBe('requested')
    // The body changed after the request: fail against the requested hash, translate nothing.
    const calls: TranslationRequest[] = []
    const deps = { db: t.db, translator: createMockTranslator({ calls }) }
    expect(
      await translateArticleBody(deps, article.id, 'zh-Hans', { onDemand: true }),
    ).toMatchObject({ status: 'skipped', reason: 'content changed since the request' })
    expect(calls).toHaveLength(0)
    let [row] = await t.db
      .select()
      .from(articleTranslations)
      .where(eq(articleTranslations.articleId, article.id))
    expect(row).toMatchObject({ status: 'failed', contentHash: 'stale-hash', html: null })

    // Requested for the current content with a tiny reservation: the attempt stops there.
    expect(
      await requestBodyTranslation(
        t.db,
        article.id,
        'zh-Hans',
        article.contentHash,
        undefined,
        reservation,
      ),
    ).toBe('requested')
    const out = await translateArticleBody(deps, article.id, 'zh-Hans', { onDemand: true })
    expect(out.status).toBe('partial')
    expect(out.failed).toBeGreaterThan(0)
    ;[row] = await t.db
      .select()
      .from(articleTranslations)
      .where(eq(articleTranslations.articleId, article.id))
    expect(row?.status).toBe('partial')
    expect(await t.db.select().from(translationRequests)).toHaveLength(1)
  })

  test('with an attempt that is not the current request, nothing is written at all', async () => {
    const { article } = await seedArticle()
    const calls: TranslationRequest[] = []
    const deps = { db: t.db, translator: createMockTranslator({ calls }) }
    // No request row at all (the reader withdrew, or the row was retired): the running write
    // is refused before any provider call.
    const out = await translateArticleBody(deps, article.id, 'zh-Hans', {
      onDemand: true,
      attempt: crypto.randomUUID(),
    })
    expect(out).toEqual({
      status: 'skipped',
      reason: 'superseded',
      translated: 0,
      cached: 0,
      failed: 0,
    })
    expect(calls).toHaveLength(0)
    expect(await t.db.select().from(articleTranslations)).toHaveLength(0)
  })

  test('an attempt given up mid-run stops at its next chunk and leaves the row alone', async () => {
    const { article } = await seedArticle()
    const attempts: string[] = []
    await requestBodyTranslation(
      t.db,
      article.id,
      'zh-Hans',
      article.contentHash,
      async (_tx, attempt) => {
        attempts.push(attempt)
      },
    )
    const inner = createMockTranslator()
    const translator = {
      model: inner.model,
      translate: async (req: TranslationRequest) => {
        // The scheduler gave up on this attempt while the provider was answering.
        await t.db.execute(sql`update article_translations set attempt = gen_random_uuid()`)
        return inner.translate(req)
      },
    }
    const out = await translateArticleBody({ db: t.db, translator }, article.id, 'zh-Hans', {
      onDemand: true,
      attempt: attempts[0] as string,
    })
    expect(out).toMatchObject({ status: 'skipped', reason: 'attempt lost' })
    // The chunk it paid for is kept for the next attempt; the row itself is left alone.
    expect((await t.db.select().from(translations)).length).toBeGreaterThan(0)
    const [row] = await t.db.select().from(articleTranslations)
    expect(row).toMatchObject({ status: 'running', html: null })
  })

  test('an execution past its budget continues the same attempt in a fresh job', async () => {
    const { article } = await seedArticle()
    const attempts: string[] = []
    await requestBodyTranslation(
      t.db,
      article.id,
      'zh-Hans',
      article.contentHash,
      async (_tx, attempt) => {
        attempts.push(attempt)
      },
    )
    const calls: TranslationRequest[] = []
    const deps = { db: t.db, translator: createMockTranslator({ calls }) }
    const attempt = attempts[0] as string
    const out = await translateArticleBody(deps, article.id, 'zh-Hans', {
      onDemand: true,
      attempt,
      deadline: Date.now() - 1,
    })
    expect(out).toMatchObject({
      status: 'skipped',
      reason: 'continued',
      resend: { attempt, requestedBy: null },
    })
    expect(calls).toHaveLength(0)
    expect((await t.db.select().from(articleTranslations))[0]?.status).toBe('running')
    // The continuation carries the same attempt and finishes the work.
    const done = await translateArticleBody(deps, article.id, 'zh-Hans', {
      onDemand: true,
      attempt,
      deadline: Date.now() + 60_000,
    })
    expect(done.status).toBe('done')
  })

  test('an early outcome for a superseded attempt is refused and names the current one', async () => {
    const { article } = await seedArticle()
    const attempts: string[] = []
    const remember = async (_tx: unknown, attempt: string) => {
      attempts.push(attempt)
    }
    await requestBodyTranslation(t.db, article.id, 'zh-Hans', 'old-hash', remember)
    await requestBodyTranslation(t.db, article.id, 'zh-Hans', article.contentHash, remember)
    // The article turns out to be in the reading language: an early 'done' write, on behalf
    // of the first attempt, which is no longer the row's.
    await t.db.update(articles).set({ sourceLang: 'zh-Hans' }).where(eq(articles.id, article.id))
    const out = await translateArticleBody(
      { db: t.db, translator: createMockTranslator() },
      article.id,
      'zh-Hans',
      { onDemand: true, attempt: attempts[0] as string },
    )
    expect(out).toMatchObject({ reason: 'superseded', resend: { attempt: attempts[1] } })
    const [row] = await t.db.select().from(articleTranslations)
    expect(row).toMatchObject({ status: 'requested', contentHash: article.contentHash })
  })

  test('a job for a superseded attempt steps aside and asks for the current one to run', async () => {
    const userA = '11111111-1111-4111-8111-111111111111'
    const userB = '22222222-2222-4222-8222-222222222222'
    await t.db.execute(
      sql`insert into auth.users (id, email) values (${userA}, 'a@x.test'), (${userB}, 'b@x.test')`,
    )
    const { article } = await seedArticle()
    const attempts: string[] = []
    const remember = async (_tx: unknown, attempt: string) => {
      attempts.push(attempt)
    }
    const reserve = (requestedBy: string) => ({
      requestedBy,
      reserveTokens: 1000,
      allowanceTokens: 400_000,
    })
    // A asks, then the article changes and B asks: B's request is the current attempt.
    await requestBodyTranslation(t.db, article.id, 'zh-Hans', 'old-hash', remember, reserve(userA))
    await requestBodyTranslation(
      t.db,
      article.id,
      'zh-Hans',
      article.contentHash,
      remember,
      reserve(userB),
    )
    const calls: TranslationRequest[] = []
    const deps = { db: t.db, translator: createMockTranslator({ calls }) }
    // A's job runs first (the queue kept B's out): it translates nothing and names B's attempt.
    const stale = await translateArticleBody(deps, article.id, 'zh-Hans', {
      onDemand: true,
      requestedBy: userA,
      attempt: attempts[0] as string,
    })
    expect(stale).toMatchObject({
      status: 'skipped',
      reason: 'superseded',
      resend: { attempt: attempts[1], requestedBy: userB },
    })
    expect(calls).toHaveLength(0)
    const [row] = await t.db.select().from(articleTranslations)
    expect(row).toMatchObject({ status: 'requested', contentHash: article.contentHash })
    // B's job completes normally and the usage is B's.
    const fresh = await translateArticleBody(deps, article.id, 'zh-Hans', {
      onDemand: true,
      requestedBy: userB,
      attempt: attempts[1] as string,
    })
    expect(fresh.status).toBe('done')
    const usage = await t.db.select().from(llmUsage)
    expect(usage.every((u) => u.userId === userB)).toBe(true)
  })

  test('background work stops at the daily budget; on-demand continues', async () => {
    const { article } = await seedArticle()
    await t.db
      .insert(llmUsage)
      .values({ job: 'x', model: 'mock', inputTokens: 900, outputTokens: 200 })
    const deps = { db: t.db, translator: createMockTranslator(), dailyBudgetTokens: 1000 }
    expect(await translateArticleBody(deps, article.id, 'zh-Hans')).toMatchObject({
      status: 'skipped',
      reason: 'daily budget exhausted',
    })
    expect(
      await translateArticleBody(deps, article.id, 'zh-Hans', { onDemand: true }),
    ).toMatchObject({ status: 'done' })
  })
})

describe('translateArticleTitle', () => {
  test('stores a translated title and excerpt without touching the body state', async () => {
    const { article } = await seedArticle()
    const translator = createMockTranslator()
    expect(await translateArticleTitle({ db: t.db, translator }, article.id, 'zh-Hans')).toEqual({
      status: 'done',
    })
    const [row] = await t.db
      .select()
      .from(articleTranslations)
      .where(eq(articleTranslations.articleId, article.id))
    expect(row?.status).toBe('pending')
    expect(row?.title).toBe('zh-Hans:The bakery that outlived three metro lines')
    expect(row?.excerpt?.startsWith('zh-Hans:')).toBe(true)
    expect(row?.html).toBeNull()
    // Cached: a second call does not add usage.
    await translateArticleTitle({ db: t.db, translator }, article.id, 'zh-Hans')
    expect(await t.db.select().from(llmUsage)).toHaveLength(1)
    // Body translation afterwards keeps the title.
    await translateArticleBody({ db: t.db, translator }, article.id, 'zh-Hans', { onDemand: true })
    const [after] = await t.db
      .select()
      .from(articleTranslations)
      .where(eq(articleTranslations.articleId, article.id))
    expect(after?.status).toBe('done')
    expect(after?.title).toBe('zh-Hans:The bakery that outlived three metro lines')
  })

  test('keeps a title the model returns unchanged, like a package name', async () => {
    // 'llm-openrouter 0.7.1' is exactly at the short-block guard, so the echo check applied and
    // rejected it as 'identical to source'. That failure wrote no row and never retried, so the
    // post kept its English title forever. A name is its own translation.
    await seedArticle()
    const title = 'llm-openrouter 0.7.1'
    const articleId = await seedArticleWithKey('k-pkg', title)
    const echo: Translator = {
      model: 'echo',
      translate: async (request) => ({
        translations: request.blocks.map((b) => ({ id: b.id, text: b.text })),
        usage: { model: 'echo', inputTokens: 1, outputTokens: 1, latencyMs: 1 },
      }),
    }
    expect(
      await translateArticleTitle({ db: t.db, translator: echo }, articleId, 'zh-Hans'),
    ).toEqual({ status: 'done' })
    const [row] = await t.db
      .select()
      .from(articleTranslations)
      .where(eq(articleTranslations.articleId, articleId))
    expect(row?.title).toBe(title)
  })

  test('rejects an echoed excerpt so it cannot poison the body cache', async () => {
    const prose =
      'This ordinary prose is the whole article and still needs to be translated for the reader.'
    const { article } = await seedArticle({ html: `<p>${prose}</p>` })
    const echoExcerpt: Translator = {
      model: 'partial-echo',
      translate: async (request) => ({
        translations: request.blocks.map((block) => ({
          id: block.id,
          text: block.id === 'title' ? `zh-Hans:${block.text}` : block.text,
        })),
        usage: { model: 'partial-echo', inputTokens: 1, outputTokens: 1, latencyMs: 1 },
      }),
    }

    expect(
      await translateArticleTitle({ db: t.db, translator: echoExcerpt }, article.id, 'zh-Hans'),
    ).toEqual({ status: 'done' })
    const [titleRow] = await t.db
      .select()
      .from(articleTranslations)
      .where(eq(articleTranslations.articleId, article.id))
    expect(titleRow?.title).toStartWith('zh-Hans:')
    expect(titleRow?.excerpt).toBeNull()
    expect(await t.db.select().from(translations)).toHaveLength(1)

    const calls: TranslationRequest[] = []
    const body = await translateArticleBody(
      { db: t.db, translator: createMockTranslator({ calls }) },
      article.id,
      'zh-Hans',
      { onDemand: true },
    )
    expect(body).toMatchObject({ status: 'done', translated: 1, cached: 0 })
    expect(calls).toHaveLength(1)
  })

  test('skips when the language already matches', async () => {
    const { article } = await seedArticle({ sourceLang: 'zh-Hans' })
    expect(
      await translateArticleTitle(
        { db: t.db, translator: createMockTranslator() },
        article.id,
        'zh-Hans',
      ),
    ).toMatchObject({ status: 'skipped' })
  })
})

describe('translation cache key', () => {
  test('the same text in two source languages gets two cache entries', async () => {
    const en = await seedArticle({ sourceLang: 'en' })
    const [feed] = await t.db.select({ id: feeds.id }).from(feeds).limit(1)
    const [de] = await t.db
      .insert(articles)
      .values({ feedId: feed!.id, dedupKey: 'k-de', title: en.article.title, sourceLang: 'de' })
      .returning({ id: articles.id })
    const calls: TranslationRequest[] = []
    const translator = createMockTranslator({ calls })
    expect(await translateArticleTitle({ db: t.db, translator }, en.article.id, 'zh-Hans')).toEqual(
      {
        status: 'done',
      },
    )
    expect(await translateArticleTitle({ db: t.db, translator }, de!.id, 'zh-Hans')).toEqual({
      status: 'done',
    })
    // Not a cache hit: the German title went to the model with its own source language.
    expect(calls.map((c) => c.sourceLang)).toEqual(['en', 'de'])
    // The English article also has an excerpt; the German one only a title. Same title hash,
    // one row per source language.
    const rows = await t.db.select().from(translations)
    const deRows = rows.filter((r) => r.sourceLang === 'de')
    expect(deRows).toHaveLength(1)
    expect(rows.filter((r) => r.sourceLang === 'en').map((r) => r.sourceHash)).toContain(
      deRows[0]?.sourceHash ?? '',
    )
  })
})

describe('daily budget and the on-demand flag', () => {
  async function overBudget() {
    await t.db
      .insert(llmUsage)
      .values({ job: 'x', model: 'mock', inputTokens: 900, outputTokens: 200 })
  }
  function ctx(): WorkerContext {
    return {
      db: t.db,
      boss,
      translator: createMockTranslator(),
      config: { LLM_DAILY_BUDGET_TOKENS: 1000 },
    } as unknown as WorkerContext
  }
  // What pg-boss hands a handler: id, name, data. No priority unless metadata was requested.
  const bodyJob = (data: TranslateBodyJob) =>
    ({ id: crypto.randomUUID(), name: QUEUES.translateBody, data }) as Job<TranslateBodyJob>
  const titleJob = (data: TranslateTitleJob) =>
    ({ id: crypto.randomUUID(), name: QUEUES.translateTitle, data }) as Job<TranslateTitleJob>

  test('title work defers on a cache miss once the budget is spent; cache hits still finish', async () => {
    const { article } = await seedArticle()
    const deps = { db: t.db, translator: createMockTranslator(), dailyBudgetTokens: 1000 }
    expect(await translateArticleTitle(deps, article.id, 'zh-Hans')).toEqual({ status: 'done' })
    await overBudget()
    expect(await translateArticleTitle(deps, article.id, 'zh-Hans')).toEqual({ status: 'done' })
    expect(await translateArticleTitle(deps, article.id, 'en')).toEqual({
      status: 'skipped',
      reason: 'not needed',
    })
    const other = await seedArticleWithKey('k2', 'Another title entirely')
    expect(await translateArticleTitle(deps, other, 'zh-Hans')).toEqual({
      status: 'deferred',
      reason: 'daily budget exhausted',
    })
  })

  test('the title handler re-queues a deferred job for the next UTC day', async () => {
    const { article } = await seedArticle()
    await overBudget()
    await handleTranslateTitle(ctx(), [titleJob({ articleId: article.id, targetLang: 'zh-Hans' })])
    const rows = await t.db.execute<{
      start_after: string
      singleton_key: string
      data: TranslateTitleJob
    }>(
      sql`select start_after, singleton_key, data from pgboss.job
          where name = ${QUEUES.translateTitle} and singleton_key = ${`${article.id}:zh-Hans`}`,
    )
    expect(rows).toHaveLength(1)
    expect(new Date(rows[0]?.start_after as string).getTime()).toBeGreaterThan(Date.now() + 1000)
    expect(rows[0]?.data).toEqual({ articleId: article.id, targetLang: 'zh-Hans' })
    expect(secondsUntilNextUtcDay(new Date('2026-09-05T23:59:30Z'))).toBe(30)
    expect(secondsUntilNextUtcDay(new Date('2026-09-05T00:00:00Z'))).toBe(86_400)
  })

  test('the handler re-sends a job for the current attempt when its own was superseded', async () => {
    const userA = '11111111-1111-4111-8111-111111111111'
    await t.db.execute(sql`insert into auth.users (id, email) values (${userA}, 'a@x.test')`)
    const { article } = await seedArticle()
    const attempts: string[] = []
    const remember = async (_tx: unknown, attempt: string) => {
      attempts.push(attempt)
    }
    await requestBodyTranslation(t.db, article.id, 'zh-Hans', 'old-hash', remember)
    await requestBodyTranslation(t.db, article.id, 'zh-Hans', article.contentHash, remember, {
      requestedBy: userA,
      reserveTokens: 1000,
      allowanceTokens: 400_000,
    })
    await t.db.execute(sql`delete from pgboss.job where name = ${QUEUES.translateBody}`)
    await handleTranslateBody(ctx(), [
      bodyJob({
        articleId: article.id,
        targetLang: 'zh-Hans',
        onDemand: true,
        attempt: attempts[0] as string,
      }),
    ])
    const queued = await t.db.execute<{ data: TranslateBodyJob }>(
      sql`select data from pgboss.job where name = ${QUEUES.translateBody}`,
    )
    expect([...queued].map((q) => q.data)).toEqual([
      {
        articleId: article.id,
        targetLang: 'zh-Hans',
        onDemand: true,
        attempt: attempts[1] as string,
        requestedBy: userA,
      },
    ])
  })

  test('the body handler takes on-demand from the payload and meters usage against the member', async () => {
    const userA = '11111111-1111-4111-8111-111111111111'
    await t.db.execute(sql`insert into auth.users (id, email) values (${userA}, 'a@x.test')`)
    const { article } = await seedArticle()
    await overBudget()
    // A job from before attempts existed runs nothing: its row was retired by the migration.
    await handleTranslateBody(ctx(), [
      bodyJob({ articleId: article.id, targetLang: 'zh-Hans', onDemand: true } as TranslateBodyJob),
    ])
    expect(await t.db.select().from(articleTranslations)).toHaveLength(0)
    let attempt = ''
    await requestBodyTranslation(
      t.db,
      article.id,
      'zh-Hans',
      article.contentHash,
      async (_tx, a) => {
        attempt = a
      },
      { requestedBy: userA, reserveTokens: 1000, allowanceTokens: 400_000 },
    )
    // Background work stops at the daily budget; the row waits.
    await handleTranslateBody(ctx(), [
      bodyJob({ articleId: article.id, targetLang: 'zh-Hans', attempt }),
    ])
    expect((await t.db.select().from(articleTranslations))[0]?.status).toBe('requested')
    await handleTranslateBody(ctx(), [
      bodyJob({
        articleId: article.id,
        targetLang: 'zh-Hans',
        onDemand: true,
        requestedBy: userA,
        attempt,
      }),
    ])
    const [row] = await t.db.select().from(articleTranslations)
    expect(row?.status).toBe('done')
    const usage = await t.db.select().from(llmUsage).where(eq(llmUsage.job, 'translate.body'))
    expect(usage.length).toBeGreaterThan(0)
    expect(usage.every((u) => u.userId === userA)).toBe(true)
  })
})

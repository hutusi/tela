/**
 * The admin console's running areas (ADR 0039): the Overview and the sidebar's badges, what
 * translation cost, and the System area's dead work, which an operator retries, dismisses or lets
 * be tried now.
 */
import { beforeEach, describe, expect, test } from 'bun:test'
import { backUp, bumpSeq, currentSeq, first, heartbeat, LEASE_KINDS } from '@tela/data'
import { USER_DAILY_TRANSLATION_TOKENS } from '@tela/shared'
import {
  ADMIN_ACTIONS,
  type AdminCounts,
  type AdminList,
  type AdminOverview,
  type AdminSystemDetail,
  type AdminSystemReport,
  type AdminSystemRow,
  type AdminTranslationReport,
  type AdminTranslationRow,
  HEALTH_CHECKS,
} from '@tela/shared/admin'
import { sql } from 'drizzle-orm'
import { ADMIN_TOKEN, createTestApi, type SignedIn, signedIn, type TestApi } from './helpers'

let api: TestApi
let ops: SignedIn
let claimant: SignedIn
let now: number

const DAY = 86_400_000
const HOUR = 3_600_000

beforeEach(async () => {
  api = await createTestApi()
  now = api.clock.now()
  ops = await signedIn(api, 'ops@x.test')
  const granted = await api.request('/api/admin/admins', {
    body: { email: 'ops@x.test', admin: true },
    headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
  })
  expect(granted.status).toBe(200)
  claimant = await signedIn(api, 'claimant@x.test')
  await api.db.batch([
    bumpSeq(api.db),
    api.db.run(sql`update profiles set handle = 'ops_one' where user_id = ${ops.userId}`),
    api.db.run(sql`update profiles set handle = 'claimer' where user_id = ${claimant.userId}`),
    api.db.run(sql`insert into sites (id, home_url, title, listing, reader_count, created_at,
        updated_at, seq)
      values (1, 'https://one.example', 'Blog One', 'listed', 5, 0, 0, ${currentSeq}),
        (2, 'https://two.example', null, 'private', 2, 0, 0, ${currentSeq}),
        (3, 'https://three.example', 'Three', 'private', 1, 0, 0, ${currentSeq})`),
    api.db.run(sql`insert into site_topics (site_id, topic) values (2, 'tech'), (2, 'art')`),
    api.db.run(sql`insert into feeds (id, site_id, feed_url, host, next_fetch_at, error_count,
        timeout_streak, last_error, created_at, updated_at, seq)
      values (1, 1, 'https://one.example/feed', 'one.example', ${now + HOUR}, 0, 0, null, 0, 0,
          ${currentSeq}),
        (2, 2, 'https://two.example/feed', 'two.example', ${now + HOUR}, 3, 0, 'HTTP 503',
          ${now - DAY}, 0, ${currentSeq}),
        (3, 3, 'https://three.example/feed', 'three.example', ${now + HOUR}, 4, 4, 'timeout',
          ${now - 10 * DAY}, 0, ${currentSeq})`),
    api.db.run(sql`insert into articles (id, feed_id, dedup_key, title, url, url_host, fetched_at,
        sort_at, extract_state, content_key, seq)
      values (1, 1, 'a', 'Post', 'https://one.example/1', 'one.example', 0, 0, 'failed', 'ck1',
        ${currentSeq})`),
    api.db.run(sql`insert into site_claims (id, site_id, user_id, method, token, status, error,
        last_checked_at, reviewed_at, created_at, seq)
      values (1, 2, ${claimant.userId}, 'meta', 'tok', 'failed', 'no meta tag', ${now - HOUR},
          null, ${now - DAY}, ${currentSeq}),
        (2, 3, ${claimant.userId}, 'meta', 'tok2', 'failed', 'gone', ${now - 2 * HOUR},
          ${now - HOUR}, ${now - DAY}, ${currentSeq})`),
  ] as never)
})

const get = async <T>(path: string, as: SignedIn = ops) => {
  const res = await api.request(`/api/v1/admin/${path}`, { as })
  return { status: res.status, body: (await res.json()) as T }
}

const act = async (action: string, ids: string[]) => {
  const res = await api.request('/api/v1/admin/act', { as: ops, body: { action, ids } })
  expect(res.status).toBe(200)
  return (await res.json()) as {
    done: string[]
    failed: { id: string; error: string }[]
    undo: { group: string } | null
  }
}

async function deadLetter(kind: string, key: string, at = now - HOUR, resolved = false) {
  const [row] = await api.db.all<{ id: number }>(sql`
    insert into dead_letters (kind, key, attempts, error, at, resolved_at, resolution)
    values (${kind}, ${key}, 5, ${`${kind} kept failing`}, ${at}, ${resolved ? now : null},
      ${resolved ? 'dismissed' : null})
    returning id
  `)
  return row?.id ?? 0
}

describe('the badges and the Overview', () => {
  test('count what waits on an operator, and nothing reviewed or resolved', async () => {
    await deadLetter('feed.fetch', '1')
    await deadLetter('feed.fetch', '1', now - 2 * HOUR, true)
    const { status, body } = await get<AdminCounts>('counts')
    expect(status).toBe(200)
    // Claim 2 was reviewed after its last check; feed 1 is fine.
    expect(body).toEqual({ claims: 1, feeds: 2, dead: 1 })
  })

  test('is refused to a member who is not an admin', async () => {
    expect((await get('overview', claimant)).status).toBe(403)
    expect((await get('system/report', claimant)).status).toBe(403)
  })

  test('shows health, the queues with their rows, the week, and recent activity', async () => {
    const dead = await deadLetter('feed.fetch', '2')
    await act('site.hide', ['3'])
    const { status, body } = await get<AdminOverview>('overview')
    expect(status).toBe(200)
    expect(body.health.at).toBe(now)
    expect(body.health.checks.map((c) => c.name)).toEqual([...HEALTH_CHECKS])

    const { claims, feeds, dead: letters, candidates } = body.queues
    expect(claims.count).toBe(1)
    expect(claims.rows).toEqual([
      {
        id: '1',
        actions: ['claim.recheck', 'claim.vouch', 'claim.reject', 'claim.dismiss'],
        claimId: 1,
        siteId: 2,
        siteTitle: null,
        homeUrl: 'https://two.example',
        faviconKey: null,
        claimant: { id: claimant.userId, handle: 'claimer', name: null },
        owner: null,
        method: 'meta',
        status: 'failed',
        error: 'no meta tag',
        vouched: false,
        createdAt: now - DAY,
        lastCheckedAt: now - HOUR,
        verifiedAt: null,
        reviewedAt: null,
        attempts: null,
        nextTry: null,
        readerCount: 2,
      },
    ])
    expect(feeds.count).toBe(2)
    // The worst first: more errors.
    expect(feeds.rows.map((r) => r.feedId)).toEqual([3, 2])
    expect(feeds.rows[1]).toMatchObject({
      id: '2',
      actions: ['feed.fetch', 'feed.pause'],
      siteTitle: null,
      feedUrl: 'https://two.example/feed',
      status: 'active',
      region: 'global',
      errorCount: 3,
      lastError: 'HTTP 503',
      mergedInto: null,
      owner: null,
      readerCount: 0,
    })
    expect(letters).toEqual({
      count: 1,
      rows: [
        {
          id: `dead:${dead}`,
          actions: ['dead.retry', 'dead.dismiss'],
          type: 'dead',
          deadId: dead,
          kind: 'feed.fetch',
          key: '2',
          attempts: 5,
          error: 'feed.fetch kept failing',
          at: now - HOUR,
          resolvedAt: null,
          resolution: null,
          target: { area: 'feeds', id: '2', label: 'https://two.example/feed' },
        },
      ],
    })
    // Site 3 was hidden just now: only site 2 is still a candidate.
    expect(candidates.count).toBe(1)
    expect(candidates.rows).toEqual([
      {
        id: '2',
        actions: ['site.feature', 'site.list', 'site.hide'],
        siteId: 2,
        title: null,
        homeUrl: 'https://two.example',
        faviconKey: null,
        listing: 'private',
        owner: null,
        readerCount: 2,
        feedCount: 1,
        feedHealth: 'failing',
        claimFailing: true,
        primaryLang: null,
        translationOptOut: false,
        topics: ['art', 'tech'],
        createdAt: 0,
      },
    ])

    // Two members joined this week (ops and the claimant); feed 2 was added this week, feed 3
    // the week before.
    expect(body.week.members[0]).toBe(2)
    expect(body.week.feedsAdded).toEqual([1, 1])
    expect(body.week.claimsVerified).toEqual([0, 0])
    expect(body.week.tokens).toEqual([0, 0])

    // Newest first: the hide, then the grant that opened the console (from the command line).
    expect(body.activity).toMatchObject([
      {
        action: 'site.hide',
        targetKind: 'site',
        targetKey: '3',
        label: 'Three',
        actor: { id: ops.userId, handle: 'ops_one' },
      },
      { action: 'admin.grant', targetKind: 'member', label: 'ops_one', actor: null },
    ])
  })
})

describe('Translation', () => {
  async function call(
    job: string,
    model: string,
    feedId: number | null,
    lang: string,
    tokens: [number, number],
    latency: number,
    at: number,
  ) {
    await api.db.run(sql`
      insert into llm_calls (job, model, feed_id, target_lang, input_tokens, output_tokens,
        latency_ms, created_at)
      values (${job}, ${model}, ${feedId}, ${lang}, ${tokens[0]}, ${tokens[1]}, ${latency}, ${at})
    `)
  }

  beforeEach(async () => {
    await call('translate.title', 'glm', 1, 'zh-Hans', [100, 20], 1000, now - HOUR)
    await call('translate.title', 'glm', 1, 'fr', [100, 30], 2000, now - DAY)
    await call('translate.body', 'glm', 1, 'fr', [1000, 800], 9000, now - 2 * DAY)
    await call('translate.body', 'qwen', 2, 'en', [500, 400], 4000, now - 3 * DAY)
    // Unattributed: a title call that carried several blogs' posts.
    await call('translate.title', 'glm', null, 'en', [50, 10], 500, now - HOUR)
    // Outside the thirty days.
    await call('translate.body', 'glm', 1, 'en', [9999, 9999], 100, now - 40 * DAY)
    await api.db.run(sql`update sites set translation_opt_out = 1 where id = 2`)
  })

  test('by blog: tokens, calls, the languages and the median call, with the switch to flip', async () => {
    const { body } = await get<AdminList<AdminTranslationRow, 'translation'>>('translation?f=blogs')
    expect(body.counts).toEqual({ blogs: 2, jobs: 2, models: 2 })
    expect(body.truncated).toBe(false)
    expect(body.rows).toEqual([
      {
        id: '1',
        actions: ['site.translationOff'],
        kind: 'blog',
        label: 'Blog One',
        siteId: 1,
        homeUrl: 'https://one.example',
        sourceLang: null,
        translationOptOut: false,
        targets: ['fr', 'zh-Hans'],
        calls: 3,
        inputTokens: 1200,
        outputTokens: 850,
        medianLatencyMs: 2000,
      },
      {
        id: '2',
        actions: ['site.translationOn'],
        kind: 'blog',
        label: null,
        siteId: 2,
        homeUrl: 'https://two.example',
        sourceLang: null,
        translationOptOut: true,
        targets: ['en'],
        calls: 1,
        inputTokens: 500,
        outputTokens: 400,
        medianLatencyMs: 4000,
      },
    ])
    const searched = await get<AdminList<AdminTranslationRow, 'translation'>>(
      'translation?f=blogs&q=TWO',
    )
    expect(searched.body.rows.map((r) => r.id)).toEqual(['2'])
  })

  test('by job and by model, the median of an even count the mean of the middle two', async () => {
    const jobs = await get<AdminList<AdminTranslationRow, 'translation'>>('translation?f=jobs')
    expect(jobs.body.rows.map((r) => [r.id, r.calls, r.medianLatencyMs, r.actions])).toEqual([
      ['job:translate.body', 2, 6500, []],
      ['job:translate.title', 3, 1000, []],
    ])
    const models = await get<AdminList<AdminTranslationRow, 'translation'>>('translation?f=models')
    expect(models.body.rows.map((r) => [r.id, r.label, r.inputTokens, r.kind])).toEqual([
      ['model:glm', 'glm', 1250, 'model'],
      ['model:qwen', 'qwen', 500, 'model'],
    ])
    expect((await get('translation?f=nope')).status).toBe(400)
  })

  test('the report: thirty days, the totals, the budgets and who came near the cap', async () => {
    const today = new Date(now).toISOString().slice(0, 10)
    const yesterday = new Date(now - DAY).toISOString().slice(0, 10)
    await api.db.run(sql`
      insert into usage_daily (subject, day, reserved, used)
      values ('*', ${today}, 1000, 3000),
        (${claimant.userId}, ${yesterday}, 0, ${USER_DAILY_TRANSLATION_TOKENS - 1000}),
        (${ops.userId}, ${today}, 0, 1000)
    `)
    const before = await get<AdminTranslationReport>('translation/report')
    // No tick has reported its config yet.
    expect(before.body.background).toEqual({ day: today, used: 3000, reserved: 1000, budget: null })

    await heartbeat(api.db, 'tick', now, {
      config: {
        backgroundBudget: 2_000_000,
        maxArticleTokens: 40_000,
        translator: true,
        relay: false,
        websub: false,
        assets: true,
      },
    })
    const { body } = await get<AdminTranslationReport>('translation/report')
    expect(body.days).toHaveLength(30)
    expect(body.days.at(-1)).toEqual({ day: today, title: 180, body: 0 })
    expect(body.days.at(-2)).toEqual({ day: yesterday, title: 130, body: 0 })
    expect(body.days.at(-3)).toMatchObject({ body: 1800 })
    expect(body.days[0]?.day).toBe(new Date(now - 29 * DAY).toISOString().slice(0, 10))
    expect(body.totals).toEqual({ inputTokens: 1750, outputTokens: 1260, calls: 5 })
    expect(body.unattributed).toBe(60)
    expect(body.background.budget).toBe(2_000_000)
    expect(body.memberCap).toBe(USER_DAILY_TRANSLATION_TOKENS)
    // How many, never who: a member's tokens are what they read.
    expect(body.nearCap).toBe(1)
  })
})

describe('System', () => {
  test('lists dead letters, leases backing off and resolved letters, each linked to its target', async () => {
    const extract = await deadLetter('article.extract', '1')
    const claim = await deadLetter('site.claim', '1', now - 2 * HOUR)
    const member = await deadLetter('member.gravatar', claimant.userId, now - 3 * HOUR)
    const body = await deadLetter('translate.body', 'ck1:fr', now - 4 * HOUR)
    const gone = await deadLetter('feed.fetch', '99', now - 5 * HOUR)
    const resolved = await deadLetter('site.assets', '1', now - 6 * HOUR, true)
    await api.db.run(sql`
      insert into leases (kind, key, owner, until, attempts, not_before, last_error, host)
      values ('feed.fetch', '2', 'x', 0, 2, ${now + HOUR}, 'HTTP 503', 'two.example'),
        ('feed.fetch', '3', 'y', ${now + HOUR}, 1, 0, null, 'three.example')
    `)

    const dead = await get<AdminList<AdminSystemRow, 'system'>>('system?f=dead')
    expect(dead.body.counts).toEqual({ dead: 5, retrying: 1, resolved: 1 })
    expect(dead.body.rows.map((r) => [r.id, r.target])).toEqual([
      [`dead:${extract}`, { area: 'feeds', id: '1', label: 'https://one.example/feed' }],
      [`dead:${claim}`, { area: 'claims', id: '1', label: 'https://two.example' }],
      [`dead:${member}`, { area: 'people', id: claimant.userId, label: 'claimer' }],
      [`dead:${body}`, { area: 'feeds', id: '1', label: 'https://one.example/feed' }],
      [`dead:${gone}`, null],
    ])

    const retrying = await get<AdminList<AdminSystemRow, 'system'>>('system?f=retrying')
    expect(retrying.body.rows).toEqual([
      {
        id: 'lease:feed.fetch:2',
        actions: ['lease.retryNow'],
        type: 'lease',
        kind: 'feed.fetch',
        key: '2',
        attempts: 2,
        notBefore: now + HOUR,
        lastError: 'HTTP 503',
        host: 'two.example',
        target: { area: 'feeds', id: '2', label: 'https://two.example/feed' },
      },
    ])

    const done = await get<AdminList<AdminSystemRow, 'system'>>('system?f=resolved')
    expect(done.body.rows).toMatchObject([
      {
        id: `dead:${resolved}`,
        actions: [],
        resolution: 'dismissed',
        resolvedAt: now,
        target: { area: 'sites', id: '1', label: 'Blog One' },
      },
    ])

    const searched = await get<AdminList<AdminSystemRow, 'system'>>('system?f=dead&q=GRAVATAR')
    expect(searched.body.rows.map((r) => r.id)).toEqual([`dead:${member}`])
  })

  test('the report: health, heartbeats, the last backup, and every kind of work', async () => {
    await heartbeat(api.db, 'tick', now - 60_000, {
      'feed.fetch': 1,
      config: {
        backgroundBudget: 2_000_000,
        maxArticleTokens: 40_000,
        translator: true,
        relay: true,
        websub: false,
        assets: true,
      },
    })
    await heartbeat(api.db, 'daily', now - HOUR, { revived: 0 })
    await heartbeat(api.db, 'health', now - 2 * 60_000, { ok: false, problems: ['x'] })
    await backUp(api.db, api.blobs, { date: '2026-09-28', now: () => now - 2 * HOUR })
    await api.db.run(sql`
      insert into leases (kind, key, owner, until, attempts, not_before)
      values ('feed.fetch', '2', 'x', 0, 2, ${now + HOUR}),
        ('feed.fetch', '3', 'y', ${now + HOUR}, 1, 0),
        ('site.claim', '1', 'z', ${now + HOUR}, 1, 0)
    `)
    const { body } = await get<AdminSystemReport>('system/report')
    expect(body.health).toMatchObject({ ok: true, at: now })
    expect(body.heartbeats).toEqual({
      tick: now - 60_000,
      daily: now - HOUR,
      digest: null,
      config: {
        backgroundBudget: 2_000_000,
        maxArticleTokens: 40_000,
        translator: true,
        relay: true,
        websub: false,
        assets: true,
      },
      health: { at: now - 2 * 60_000, ok: false },
    })
    expect(body.backup).toMatchObject({ date: '2026-09-28', verified: true })
    expect(body.kinds.map((k) => k.kind)).toEqual([...LEASE_KINDS])
    expect(body.kinds.find((k) => k.kind === 'feed.fetch')).toEqual({
      kind: 'feed.fetch',
      held: 1,
      retrying: 1,
    })
    expect(body.kinds.find((k) => k.kind === 'site.claim')).toEqual({
      kind: 'site.claim',
      held: 1,
      retrying: 0,
    })
    expect(body.kinds.find((k) => k.kind === 'member.gravatar')).toEqual({
      kind: 'member.gravatar',
      held: 0,
      retrying: 0,
    })
  })

  test('a record: a dead letter with its history, a lease, and nothing for what is not there', async () => {
    const id = await deadLetter('feed.fetch', '1')
    await act('dead.dismiss', [`dead:${id}`])
    const { status, body } = await get<AdminSystemDetail>(`system/dead:${id}`)
    expect(status).toBe(200)
    expect(body.row).toMatchObject({ id: `dead:${id}`, resolution: 'dismissed', actions: [] })
    expect(body.history.map((h) => h.action)).toEqual(['dead.dismiss'])

    await api.db.run(sql`
      insert into leases (kind, key, owner, until, attempts, not_before)
      values ('translate.body', 'ck1:fr', 'x', 0, 1, ${now + HOUR})
    `)
    const lease = await get<AdminSystemDetail>(
      `system/${encodeURIComponent('lease:translate.body:ck1:fr')}`,
    )
    expect(lease.body.row).toMatchObject({
      type: 'lease',
      kind: 'translate.body',
      key: 'ck1:fr',
      target: { area: 'feeds', id: '1' },
    })
    expect(lease.body.history).toEqual([])
    expect((await get('system/dead:999')).status).toBe(404)
    expect((await get('system/lease:nope:1')).status).toBe(404)
    expect((await get('system?f=nope')).status).toBe(400)
  })
})

describe('acting on dead work', () => {
  test('a retry makes the item due again and resolves the letter, once, with no undo', async () => {
    const id = await deadLetter('feed.fetch', '1')
    await api.db.run(sql`update feeds set next_fetch_at = ${now + DAY} where id = 1`)
    const res = await act('dead.retry', [`dead:${id}`])
    expect(res).toEqual({ done: [`dead:${id}`], failed: [], undo: null })
    const feed = await first<{ next_fetch_at: number }>(
      api.db,
      sql`select next_fetch_at from feeds where id = 1`,
    )
    expect(feed?.next_fetch_at).toBe(now)
    const letter = await first<Record<string, unknown>>(
      api.db,
      sql`select resolved_at, resolution, resolved_by from dead_letters where id = ${id}`,
    )
    expect(letter).toEqual({ resolved_at: now, resolution: 'retried', resolved_by: ops.userId })
    const audited = await api.db.all<{ detail: string }>(
      sql`select detail from admin_actions where action = 'dead.retry'`,
    )
    expect(JSON.parse(audited[0]?.detail ?? '{}')).toEqual({
      kind: 'feed.fetch',
      key: '1',
      from: { resolution: null },
      to: { resolution: 'retried' },
    })

    const again = await act('dead.retry', [`dead:${id}`, 'dead:999', 'nonsense'])
    expect(again.failed).toEqual([
      { id: `dead:${id}`, error: 'not_applicable' },
      { id: 'dead:999', error: 'not_found' },
      { id: 'nonsense', error: 'not_found' },
    ])
  })

  test('a body retried is requested by nobody, so the background budget pays', async () => {
    await api.db.run(sql`
      insert into body_translations (content_key, lang, state, requested_by, reserved_tokens,
        updated_at)
      values ('ck1', 'fr', 'failed', ${claimant.userId}, 0, 0)
    `)
    const id = await deadLetter('translate.body', 'ck1:fr')
    expect((await act('dead.retry', [`dead:${id}`])).done).toHaveLength(1)
    const row = await first<{ state: string; requested_by: string | null }>(
      api.db,
      sql`select state, requested_by from body_translations where content_key = 'ck1'`,
    )
    expect(row).toEqual({ state: 'requested', requested_by: null })
  })

  test("a body is not retried once the day's background budget is spent", async () => {
    await api.db.run(sql`
      insert into body_translations (content_key, lang, state, reserved_tokens, updated_at)
      values ('ck2', 'fr', 'failed', 0, 0)
    `)
    const id = await deadLetter('translate.body', 'ck2:fr')
    await heartbeat(api.db, 'tick', now, { config: { backgroundBudget: 1000 } })
    await api.db.run(sql`insert into usage_daily (subject, day, reserved, used)
      values ('*', ${new Date(now).toISOString().slice(0, 10)}, 0, 1000)`)
    expect(await act('dead.retry', [`dead:${id}`])).toMatchObject({
      done: [],
      failed: [{ id: `dead:${id}`, error: 'limit' }],
    })
    // Another kind is not background translation, and is retried whatever the budget.
    const fetch = await deadLetter('feed.fetch', '2')
    expect((await act('dead.retry', [`dead:${fetch}`])).done).toHaveLength(1)
  })

  test('a dismissal is undone while nothing has changed since, and not after', async () => {
    const id = await deadLetter('site.assets', '1')
    const first1 = await act('dead.dismiss', [`dead:${id}`])
    expect(first1.done).toEqual([`dead:${id}`])
    expect(first1.undo).not.toBeNull()
    expect((await get<AdminCounts>('counts')).body.dead).toBe(0)

    const undone = await api.request('/api/v1/admin/undo', { as: ops, body: first1.undo })
    expect(await undone.json()).toEqual({ restored: 1 })
    const letter = await first<Record<string, unknown>>(
      api.db,
      sql`select resolved_at, resolution, resolved_by from dead_letters where id = ${id}`,
    )
    expect(letter).toEqual({ resolved_at: null, resolution: null, resolved_by: null })

    // Dismissed again, then retried by someone else: the second dismissal's undo finds the letter
    // changed and restores nothing.
    const second = await act('dead.dismiss', [`dead:${id}`])
    await api.db.run(sql`update dead_letters set resolution = 'retried' where id = ${id}`)
    const refused = await api.request('/api/v1/admin/undo', { as: ops, body: second.undo })
    expect(refused.status).toBe(409)
    expect(await refused.json()).toEqual({ error: 'changed_since' })
    expect(
      (await first<{ resolution: string }>(api.db, sql`select resolution from dead_letters`))
        ?.resolution,
    ).toBe('retried')
  })

  test('retry now lets a lease backing off be claimed, never one someone holds', async () => {
    await api.db.run(sql`
      insert into leases (kind, key, owner, until, attempts, not_before)
      values ('feed.fetch', '2', 'x', 0, 2, ${now + HOUR}),
        ('feed.fetch', '3', 'y', ${now + HOUR}, 1, 0),
        ('translate.body', 'ck1:fr', 'z', 0, 1, ${now + HOUR})
    `)
    const res = await act('lease.retryNow', [
      'lease:feed.fetch:2',
      'lease:feed.fetch:3',
      'lease:translate.body:ck1:fr',
      'lease:feed.fetch:9',
      'lease:nope:1',
    ])
    expect(res.done).toEqual(['lease:feed.fetch:2', 'lease:translate.body:ck1:fr'])
    expect(res.failed).toEqual([
      { id: 'lease:feed.fetch:3', error: 'not_applicable' },
      { id: 'lease:feed.fetch:9', error: 'not_found' },
      { id: 'lease:nope:1', error: 'not_found' },
    ])
    expect(res.undo).toBeNull()
    const leases = await api.db.all<{ key: string; not_before: number; attempts: number }>(
      sql`select key, not_before, attempts from leases order by key`,
    )
    expect(leases).toEqual([
      { key: '2', not_before: 0, attempts: 2 },
      { key: '3', not_before: 0, attempts: 1 },
      { key: 'ck1:fr', not_before: 0, attempts: 1 },
    ])
  })

  test('every action this area offers is one the console knows', () => {
    for (const action of ['dead.retry', 'dead.dismiss', 'lease.retryNow']) {
      expect(ADMIN_ACTIONS).toContain(action as (typeof ADMIN_ACTIONS)[number])
    }
  })
})

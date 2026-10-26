/**
 * Reporting what a public page shows (ADR 0059): `POST /api/v1/reports`, for members only. Only
 * what anyone can see now is reportable, one open report per member per thing, and the answer is
 * the same whether or not anyone reported it before.
 */
import { beforeEach, describe, expect, test } from 'bun:test'
import { ACTION_LIMITS, currentSeq, type TelaDb } from '@tela/data'
import { sql } from 'drizzle-orm'
import { createTestApi, type SignedIn, signedIn, type TestApi } from './helpers'
import { ANNA, BEA, ROLL, seedAnna, write as writeTo } from './standing-fixture'

let api: TestApi
let db: TelaDb
let rep: SignedIn
let other: SignedIn

const write = (...statements: ReturnType<TelaDb['run']>[]) => writeTo(db, ...statements)

beforeEach(async () => {
  api = await createTestApi()
  db = api.db
  rep = await signedIn(api, 'rep@x.test')
  other = await signedIn(api, 'other@x.test')
  // Anna writes blog 1, recommends post 1 with a note and has a public blogroll.
  await seedAnna(api, rep)
})

const report = (body: unknown, as: SignedIn | undefined = rep) =>
  api.request('/api/v1/reports', { body, ...(as ? { as } : {}) })

const reportRows = () =>
  db.all<{
    reporter_id: string
    target_kind: string
    target_key: string
    reason: string
    details: string | null
    url: string | null
    state: string
  }>(sql`select reporter_id, target_kind, target_key, reason, details, url, state from reports
    order by id`)

describe('reporting', () => {
  test('a member reports each kind of thing a public page shows', async () => {
    for (const body of [
      { targetKind: 'profile', targetKey: ANNA, reason: 'impersonation' },
      { targetKind: 'blogroll', targetKey: ROLL, reason: 'spam', details: '  Ads.  ' },
      { targetKind: 'site', targetKey: '2', reason: 'copyright', url: 'https://tela.test/s/2' },
      { targetKind: 'recommendation', targetKey: `${ANNA}:1`, reason: 'abuse', details: '' },
    ]) {
      const res = await report(body)
      expect({ body, status: res.status }).toEqual({ body, status: 200 })
      expect(await res.json()).toEqual({ ok: true })
      expect(res.headers.get('cache-control')).toBe('no-store')
    }
    expect(await reportRows()).toEqual([
      expect.objectContaining({ target_kind: 'profile', target_key: ANNA, state: 'open' }),
      expect.objectContaining({ target_kind: 'blogroll', details: 'Ads.', url: null }),
      expect.objectContaining({
        target_kind: 'site',
        target_key: '2',
        url: 'https://tela.test/s/2',
      }),
      expect.objectContaining({ target_key: `${ANNA}:1`, reason: 'abuse', details: null }),
    ])
    expect((await reportRows()).every((r) => r.reporter_id === rep.userId)).toBe(true)
  })

  test('is refused for anything that is not a report, and for a visitor', async () => {
    for (const body of [
      null,
      { targetKind: 'article', targetKey: '1', reason: 'spam' },
      { targetKind: 'site', targetKey: '01', reason: 'spam' },
      { targetKind: 'site', targetKey: '2', reason: 'boring' },
      { targetKind: 'profile', targetKey: 'x', reason: 'spam' },
      { targetKind: 'recommendation', targetKey: ANNA, reason: 'spam' },
      { targetKind: 'site', targetKey: '2', reason: 'spam', details: 'x'.repeat(1001) },
      { targetKind: 'site', targetKey: '2', reason: 'spam', details: 'a\u0000b' },
      { targetKind: 'site', targetKey: '2', reason: 'spam', details: 7 },
      { targetKind: 'site', targetKey: '2', reason: 'spam', url: 'javascript:alert(1)' },
    ]) {
      expect({ body, status: (await report(body)).status }).toEqual({ body, status: 400 })
    }
    // A thousand characters in code points, as the table counts them: 1,000 emoji are 2,000
    // UTF-16 units, and still fit.
    const emoji = '🙂'.repeat(1000)
    const fits = await report({
      targetKind: 'site',
      targetKey: '2',
      reason: 'other',
      details: emoji,
    })
    expect(fits.status).toBe(200)
    const visitor = await api.request('/api/v1/reports', {
      body: { targetKind: 'site', targetKey: '2', reason: 'spam' },
    })
    expect(visitor.status).toBe(401)
  })

  test('only what anyone can see now: never a private, hidden or taken-back thing', async () => {
    await write(
      db.run(sql`insert into blogrolls (id, user_id, name, is_public, public_version, created_at,
          updated_at, seq)
        values ('privateRoll1', ${ANNA}, 'Mine', 0, 0, 0, 0, ${currentSeq})`),
      db.run(
        sql`update recommendations set deleted_at = 1 where user_id = ${BEA} and article_id = 2`,
      ),
      db.run(sql`update profiles set suspended_at = 1 where user_id = ${BEA}`),
    )
    for (const body of [
      { targetKind: 'blogroll', targetKey: 'privateRoll1', reason: 'spam' },
      { targetKind: 'blogroll', targetKey: 'nobodysRoll1', reason: 'spam' },
      { targetKind: 'site', targetKey: '3', reason: 'spam' },
      { targetKind: 'site', targetKey: '99', reason: 'spam' },
      { targetKind: 'profile', targetKey: BEA, reason: 'spam' },
      { targetKind: 'profile', targetKey: 'u-nobody-0001', reason: 'spam' },
      // Bea's recommendation of post 1 has no note; of post 2 is taken back.
      { targetKind: 'recommendation', targetKey: `${BEA}:1`, reason: 'spam' },
      { targetKind: 'recommendation', targetKey: `${BEA}:2`, reason: 'spam' },
    ]) {
      const res = await report(body)
      expect({ body, status: res.status }).toEqual({ body, status: 404 })
    }
    expect(await reportRows()).toEqual([])
  })

  test('one open report per member per thing; a repeat is answered alike and changes nothing', async () => {
    const body = { targetKind: 'profile', targetKey: ANNA, reason: 'spam', details: 'First' }
    expect((await report(body)).status).toBe(200)
    const again = await report({ ...body, reason: 'abuse', details: 'Second' })
    expect(again.status).toBe(200)
    expect(await again.json()).toEqual({ ok: true })
    expect((await reportRows()).map((r) => r.details)).toEqual(['First'])
    // Another member's report of the same profile is a report of its own.
    expect((await report(body, other)).status).toBe(200)
    expect((await reportRows()).length).toBe(2)
    // Once the operator has decided, the member can report it again.
    await db.run(sql`update reports set state = 'dismissed', resolved_at = 1`)
    expect((await report({ ...body, details: 'Third' })).status).toBe(200)
    expect((await reportRows()).map((r) => [r.details, r.state])).toEqual([
      ['First', 'dismissed'],
      ['First', 'dismissed'],
      ['Third', 'open'],
    ])
  })

  test(`at most ${ACTION_LIMITS.report.limit} a day per member, repeats counted`, async () => {
    const body = { targetKind: 'site', targetKey: '2', reason: 'spam' }
    for (let i = 0; i < ACTION_LIMITS.report.limit; i++) {
      expect((await report(body)).status).toBe(200)
    }
    const over = await report(body)
    expect(over.status).toBe(429)
    expect(Number(over.headers.get('retry-after'))).toBeGreaterThan(0)
    // Another member's day is their own.
    expect((await report(body, other)).status).toBe(200)
  })
})

/**
 * People and Invitations in the admin console (ADR 0039, 0034): who is a member and how they got
 * in, never what they read; signing a member out; the codes, the holds waiting on them, and the
 * operator's actions on both, each audited without an address.
 */
import { beforeEach, describe, expect, test } from 'bun:test'
import { createMemberCode, createOperatorCode, first, listMemberCodes } from '@tela/data'
import { groupInviteCode, INVITE_ALLOWANCE } from '@tela/shared'
import type {
  AdminActResponse,
  AdminCodeRow,
  AdminHoldRow,
  AdminInviteDetail,
  AdminInviteRow,
  AdminList,
  AdminPersonDetail,
  AdminPersonRow,
} from '@tela/shared/admin'
import { sql } from 'drizzle-orm'
import {
  ADMIN_TOKEN,
  codeFor,
  cookiesOf,
  createTestApi,
  memberHeaders,
  type SignedIn,
  signedIn,
  type TestApi,
} from './helpers'

let api: TestApi
let ops: SignedIn
let n = 0

/** Each visitor request from an IP of its own, so the per-IP limits stay out of the way. */
const ip = () => {
  n++
  return `198.51.${100 + (n >> 8)}.${n & 255}`
}

beforeEach(async () => {
  api = await createTestApi()
  ops = await signedIn(api, 'ops@x.test')
  const granted = await api.request('/api/admin/admins', {
    body: { email: 'ops@x.test', admin: true },
    headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
  })
  expect(granted.status).toBe(200)
})

const act = async (body: unknown, as = ops) => {
  const res = await api.request('/api/v1/admin/act', { as, body })
  expect(res.status).toBe(200)
  return (await res.json()) as AdminActResponse
}

const undo = (group: string) => api.request('/api/v1/admin/undo', { as: ops, body: { group } })

async function get<T>(path: string, as = ops): Promise<T> {
  const res = await api.request(`/api/v1/admin/${path}`, { as })
  expect(res.status).toBe(200)
  return (await res.json()) as T
}

/** A search is posted, never put in the URL: it is often an address (ADR 0039). */
async function search<T>(area: string, f: string, q: string): Promise<T> {
  const res = await api.request(`/api/v1/admin/${area}`, { as: ops, body: { f, q } })
  expect(res.status).toBe(200)
  return (await res.json()) as T
}

const people = (f: string, q = '') =>
  q
    ? search<AdminList<AdminPersonRow, 'people'>>('people', f, q)
    : get<AdminList<AdminPersonRow, 'people'>>(`people?f=${f}`)
const invites = (f: string, q = '') =>
  q
    ? search<AdminList<AdminInviteRow, 'invites'>>('invites', f, q)
    : get<AdminList<AdminInviteRow, 'invites'>>(`invites?f=${f}`)

/** A visitor joins with `code` and signs in with the code mailed to them. */
async function joinWith(code: string, email: string): Promise<SignedIn> {
  const joined = await api.request('/api/v1/join', {
    body: { code, email },
    headers: { 'cf-connecting-ip': ip() },
  })
  expect(joined.status).toBe(200)
  const res = await api.request('/api/auth/sign-in/email-otp', {
    body: { email, otp: codeFor(api, email) },
    headers: { 'cf-connecting-ip': ip() },
  })
  expect(res.status).toBe(200)
  const cookie = cookiesOf(res)
  const me = (await (await api.request('/api/v1/me', { cookie })).json()) as { id: string }
  return { cookie, userId: me.id, headers: memberHeaders(me.id) }
}

/** A visitor asks to join with `code` and never signs in: a hold. */
async function hold(code: string, email: string): Promise<number> {
  const joined = await api.request('/api/v1/join', {
    body: { code, email },
    headers: { 'cf-connecting-ip': ip() },
  })
  expect(joined.status).toBe(200)
  const row = await first<{ id: number }>(
    api.db,
    sql`select id from invite_redemptions where email = ${email} and redeemed_at is null`,
  )
  return row?.id ?? 0
}

const operatorCode = (code: string, maxUses = 5) =>
  createOperatorCode(api.db, { code, maxUses, now: api.clock.now() })

const handleOf = async (userId: string) =>
  (
    await first<{ handle: string }>(
      api.db,
      sql`select handle from profiles where user_id = ${userId}`,
    )
  )?.handle ?? ''

const codeRow = async (code: string) =>
  first<{ max_uses: number; revoked_at: number | null }>(
    api.db,
    sql`select max_uses, revoked_at from invite_codes where code = ${code}`,
  )

const auditRows = (action: string) =>
  api.db.all<{ target_kind: string; target_key: string; detail: string; actor_id: string }>(
    sql`select target_kind, target_key, detail, actor_id from admin_actions where action = ${action}
      order by id`,
  )

describe('searching', () => {
  test('is posted; a search in the URL is not read, and a malformed body is refused', async () => {
    const all = await get<AdminList<AdminPersonRow, 'people'>>('people?f=admins&q=nobody')
    expect(all.rows.length).toBeGreaterThan(0)
    for (const body of [{ f: 7 }, { q: 'x'.repeat(201) }, { f: 'nope' }]) {
      const res = await api.request('/api/v1/admin/people', { as: ops, body })
      expect(res.status).toBe(400)
    }
  })
})

describe('people', () => {
  test('lists admins and members apart, with every count under the search', async () => {
    const ann = await signedIn(api, 'ann@x.test')
    const [annCode] = await Promise.all([createMemberCode(api.db, { userId: ann.userId, now: 0 })])
    if (!annCode?.ok) throw new Error('no code')
    await joinWith(annCode.code, 'bob@y.test')

    const admins = await people('admins')
    expect(admins.counts).toEqual({ admins: 1, members: 2 })
    expect(admins.rows.map((r) => r.email)).toEqual(['ops@x.test'])
    expect(admins.truncated).toBe(false)
    const members = await people('members')
    expect(members.rows.map((r) => r.email).sort()).toEqual(['ann@x.test', 'bob@y.test'])
    expect(members.rows.every((r) => !r.isAdmin)).toBe(true)

    // By address, by handle, and a wildcard typed is a character searched for.
    expect((await people('members', 'Y.TEST')).counts).toEqual({ admins: 0, members: 1 })
    const handle = await handleOf(ann.userId)
    expect((await people('members', handle)).rows.map((r) => r.userId)).toEqual([ann.userId])
    expect((await people('members', '%')).counts).toEqual({ admins: 0, members: 0 })
    expect((await api.request('/api/v1/admin/people?f=staff', { as: ops })).status).toBe(400)
  })

  test('says how each got in, their ways in, their blogs, invites and sessions', async () => {
    const ann = await signedIn(api, 'ann@x.test')
    const made = await createMemberCode(api.db, { userId: ann.userId, now: 0 })
    if (!made.ok) throw new Error('no code')
    const bob = await joinWith(made.code, 'bob@x.test')
    await operatorCode('WELCOME')
    const cat = await joinWith('welcome', 'cat@x.test')
    // Invited, never signed in.
    const dee = (await (
      await api.request('/api/admin/invite', {
        body: { email: 'dee@x.test' },
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      })
    ).json()) as { userId: string }
    // A password and GitHub for Ann; a code sign-in writes no account row.
    await api.db.run(sql`insert into account (id, account_id, provider_id, user_id, password,
        created_at, updated_at)
      values ('acc-1', ${ann.userId}, 'credential', ${ann.userId}, 'hash', 0, 0),
        ('acc-2', '4242', 'github', ${ann.userId}, null, 0, 0)`)
    await api.db.run(sql`insert into sites (home_url, title, listing, claimed_by, reader_count,
        created_at, updated_at)
      values ('https://ann.example', 'Ann writes', 'listed', ${ann.userId}, 4, 0, 0)`)

    const rows = new Map((await people('members')).rows.map((r) => [r.userId, r]))
    const annHandle = await handleOf(ann.userId)
    expect(rows.get(ann.userId)).toMatchObject({
      id: ann.userId,
      actions: ['member.signOut'],
      email: 'ann@x.test',
      signIn: ['credential', 'github'],
      invitedBy: { kind: 'operator' },
      blogs: 1,
      invitesUsed: 1,
      sessions: 1,
      lastSeenAt: expect.any(Number),
    })
    expect(rows.get(bob.userId)).toMatchObject({
      signIn: [],
      invitedBy: {
        kind: 'member',
        by: { id: ann.userId, handle: annHandle, name: null },
        code: made.code,
      },
      blogs: 0,
      invitesUsed: 0,
    })
    expect(rows.get(cat.userId)?.invitedBy).toEqual({ kind: 'code', code: 'WELCOME' })
    // Nobody to sign out: no session, nothing to offer.
    expect(rows.get(dee.userId)).toMatchObject({
      actions: [],
      sessions: 0,
      lastSeenAt: null,
      invitedBy: { kind: 'operator' },
    })
  })

  test('never carries what a member reads, subscribes to, likes, highlights, recommends or follows', async () => {
    const ann = await signedIn(api, 'ann@x.test')
    const bob = await signedIn(api, 'bob@x.test')
    await api.db.batch([
      api.db.run(sql`insert into sites (id, home_url, title, listing, created_at, updated_at)
        values (7, 'https://secret-site.example', 'SECRET-SITE', 'private', 0, 0)`),
      api.db.run(sql`insert into feeds (id, site_id, feed_url, host, next_fetch_at, created_at,
          updated_at)
        values (7, 7, 'https://secret-site.example/feed', 'secret-site.example', 0, 0, 0)`),
      api.db.run(sql`insert into articles (id, feed_id, dedup_key, title, fetched_at, sort_at,
          source_lang, current_version, content_key)
        values (7, 7, 'k7', 'SECRET-ARTICLE', 0, 0, 'en', 1, 'ckey7')`),
      api.db.run(sql`insert into subscriptions (user_id, feed_id, created_at, updated_at)
        values (${ann.userId}, 7, 0, 0)`),
      api.db.run(sql`insert into user_article_states (user_id, article_id, read_at, liked_at)
        values (${ann.userId}, 7, 1, 1)`),
      api.db.run(sql`insert into highlights (id, user_id, article_id, content_key, side, leaf_id,
          start, "end", quote, note, created_at, updated_at)
        values ('h1', ${ann.userId}, 7, 'ckey7', 'original', 'b1', 0, 5, 'SECRET-QUOTE',
          'SECRET-HIGHLIGHT-NOTE', 0, 0)`),
      api.db.run(sql`insert into recommendations (user_id, article_id, note, created_at, updated_at)
        values (${ann.userId}, 7, 'SECRET-RECOMMENDATION', 0, 0)`),
      api.db.run(sql`insert into follows (follower_id, followee_id, created_at, updated_at)
        values (${ann.userId}, ${bob.userId}, 0, 0)`),
    ] as never)

    const list = await people('members')
    const row = list.rows.find((r) => r.userId === ann.userId)
    expect(Object.keys(row ?? {}).sort()).toEqual(
      [
        'actions',
        'avatar',
        'blogs',
        'email',
        'handle',
        'id',
        'invitedBy',
        'invitesUsed',
        'isAdmin',
        'joinedAt',
        'lastSeenAt',
        'name',
        'sessions',
        'signIn',
        'userId',
      ].sort(),
    )
    const detail = await get<AdminPersonDetail>(`people/${ann.userId}`)
    expect(Object.keys(detail).sort()).toEqual(['bio', 'blogs', 'codes', 'history', 'person'])
    for (const answer of [row, detail]) {
      const text = JSON.stringify(answer)
      expect(text).not.toContain('SECRET')
      expect(text).not.toContain('secret-site')
      expect(text).not.toContain('ckey7')
      expect(text).not.toContain(bob.userId)
    }
  })

  test("a member's record: bio, claimed blogs, their codes and who joined by each", async () => {
    const ann = await signedIn(api, 'ann@x.test')
    await api.db.run(sql`update profiles set bio = 'Writes slowly.' where user_id = ${ann.userId}`)
    const [site] = await api.db.all<{ id: number }>(sql`insert into sites (home_url, title, listing,
        claimed_by, claimed_at, reader_count, created_at, updated_at)
      values ('https://ann.example', 'Ann writes', 'featured', ${ann.userId}, 1, 12, 0, 0)
      returning id`)
    const used = await createMemberCode(api.db, { userId: ann.userId, now: 1 })
    const open = await createMemberCode(api.db, { userId: ann.userId, now: 2 })
    if (!used.ok || !open.ok) throw new Error('no code')
    const bob = await joinWith(used.code, 'bob@x.test')

    const detail = await get<AdminPersonDetail>(`people/${ann.userId}`)
    expect(detail.bio).toBe('Writes slowly.')
    expect(detail.person.userId).toBe(ann.userId)
    expect(detail.blogs).toEqual([
      {
        siteId: site?.id ?? 0,
        title: 'Ann writes',
        homeUrl: 'https://ann.example',
        listing: 'featured',
        readerCount: 12,
      },
    ])
    expect(detail.codes.map((c) => [c.code, c.used, c.actions])).toEqual([
      [used.code, 1, []],
      [open.code, 0, ['code.revoke']],
    ])
    expect(detail.codes[0]?.joined).toEqual([
      { id: bob.userId, handle: await handleOf(bob.userId), name: null },
    ])
    expect(detail.codes[0]?.createdBy?.id).toBe(ann.userId)
    expect(detail.history).toEqual([])
    expect((await api.request('/api/v1/admin/people/nobody', { as: ops })).status).toBe(404)
  })

  test('is closed to a member who is not an admin', async () => {
    const ann = await signedIn(api, 'ann@x.test')
    expect((await api.request('/api/v1/admin/people?f=members', { as: ann })).status).toBe(403)
    expect((await api.request('/api/v1/admin/invites?f=codes', { as: ann })).status).toBe(403)
  })
})

describe('signing a member out', () => {
  test('ends every session, which the account route then refuses at once', async () => {
    const ann = await signedIn(api, 'ann@x.test')
    // A second device.
    const again = await api.request('/api/auth/sign-in/email-otp', {
      body: {
        email: 'ann@x.test',
        otp: await (async () => {
          await api.request('/api/auth/email-otp/send-verification-otp', {
            body: { email: 'ann@x.test', type: 'sign-in' },
            headers: { 'cf-connecting-ip': ip() },
          })
          return codeFor(api, 'ann@x.test')
        })(),
      },
      headers: { 'cf-connecting-ip': ip() },
    })
    expect(again.status).toBe(200)
    expect((await api.request('/api/v1/account', { as: ann })).status).toBe(200)

    const answer = await act({ action: 'member.signOut', ids: [ann.userId] })
    expect(answer).toEqual({ done: [ann.userId], failed: [], undo: null })
    const left = await first<{ n: number }>(
      api.db,
      sql`select count(*) as n from session where user_id = ${ann.userId}`,
    )
    expect(left?.n).toBe(0)
    // The account route reads past the signed five-minute copy of the session.
    expect((await api.request('/api/v1/account', { as: ann })).status).toBe(401)
    const device = { cookie: cookiesOf(again), userId: ann.userId, headers: ann.headers }
    expect((await api.request('/api/v1/account', { as: device })).status).toBe(401)

    const [row] = await auditRows('member.signOut')
    expect(row).toMatchObject({
      target_kind: 'member',
      target_key: ann.userId,
      actor_id: ops.userId,
    })
    expect(JSON.parse(row?.detail ?? '{}')).toEqual({ from: { sessions: 2 }, to: { sessions: 0 } })

    expect(await act({ action: 'member.signOut', ids: [ann.userId, 'nobody'] })).toEqual({
      done: [],
      failed: [
        { id: ann.userId, error: 'not_applicable' },
        { id: 'nobody', error: 'not_found' },
      ],
      undo: null,
    })
    const detail = await get<AdminPersonDetail>(`people/${ann.userId}`)
    expect(detail.history.map((h) => h.action)).toEqual(['member.signOut'])
    expect(detail.person.actions).toEqual([])
  })
})

describe('codes', () => {
  test('makes an operator code, and refuses one taken or not a code', async () => {
    const made = await act({ action: 'code.create', ids: [], args: { code: 'spring-26', uses: 3 } })
    expect(made).toEqual({ done: [''], failed: [], undo: null })
    expect(
      await first<{ created_by: string | null; max_uses: number }>(
        api.db,
        sql`select created_by, max_uses from invite_codes where code = 'SPRING26'`,
      ),
    ).toEqual({ created_by: null, max_uses: 3 })
    expect(await act({ action: 'code.create', ids: [], args: { code: 'Spring26' } })).toMatchObject(
      {
        failed: [{ id: '', error: 'taken' }],
      },
    )
    for (const args of [
      { code: 'ab' },
      // A member code's shape, which says whose a code is.
      { code: 'ABCDEFGHJKMN' },
      { code: 'AUTUMN', uses: 0 },
      { code: 'AUTUMN', uses: 100_001 },
      {},
    ]) {
      expect(await act({ action: 'code.create', ids: [], args })).toMatchObject({
        failed: [{ id: '', error: 'invalid' }],
      })
    }
    expect(await act({ action: 'code.create', ids: [], args: { code: 'onex' } })).toMatchObject({
      done: [''],
    })
    expect((await codeRow('ONEX'))?.max_uses).toBe(1)
    const rows = await auditRows('code.create')
    expect(rows.map((r) => [r.target_kind, r.target_key])).toEqual([
      ['code', 'SPRING26'],
      ['code', 'ONEX'],
    ])
    expect(JSON.parse(rows[0]?.detail ?? '{}')).toEqual({ from: null, to: { maxUses: 3 } })
  })

  test('adds uses to an operator code up to 100,000, and to nothing else', async () => {
    await operatorCode('BIGONE', 99_990)
    expect(await act({ action: 'code.addUses', ids: ['code:BIGONE'], args: { uses: 10 } })).toEqual(
      {
        done: ['code:BIGONE'],
        failed: [],
        undo: null,
      },
    )
    expect((await codeRow('BIGONE'))?.max_uses).toBe(100_000)
    const [row] = await auditRows('code.addUses')
    expect(JSON.parse(row?.detail ?? '{}')).toEqual({
      from: { maxUses: 99_990 },
      to: { maxUses: 100_000 },
    })
    const full = (await invites('codes')).rows.find((r) => r.id === 'code:BIGONE')
    expect(full?.actions).toEqual(['code.revoke'])

    const ann = await signedIn(api, 'ann@x.test')
    const member = await createMemberCode(api.db, { userId: ann.userId, now: 0 })
    if (!member.ok) throw new Error('no code')
    await operatorCode('OLDIE')
    await act({ action: 'code.revoke', ids: ['code:OLDIE'] })
    expect(
      await act({
        action: 'code.addUses',
        ids: ['code:BIGONE', `code:${member.code}`, 'code:OLDIE', 'code:NONE', 'hold:1'],
        args: { uses: 1 },
      }),
    ).toMatchObject({
      failed: [
        { id: 'code:BIGONE', error: 'limit' },
        { id: `code:${member.code}`, error: 'not_applicable' },
        { id: 'code:OLDIE', error: 'not_applicable' },
        { id: 'code:NONE', error: 'not_found' },
        { id: 'hold:1', error: 'not_found' },
      ],
    })
    expect(
      await act({ action: 'code.addUses', ids: ['code:OLDIE'], args: { uses: 0 } }),
    ).toMatchObject({ failed: [{ id: 'code:OLDIE', error: 'invalid' }] })
    expect((await codeRow('BIGONE'))?.max_uses).toBe(100_000)
  })

  test('revokes, cancelling the holds for good, and an undo opens the code again', async () => {
    await operatorCode('SPRING')
    await hold('SPRING', 'h@x.test')
    expect((await invites('codes')).rows.find((r) => r.id === 'code:SPRING')).toMatchObject({
      holds: 1,
      actions: ['code.addUses', 'code.revoke'],
    })
    const now = api.clock.now()
    const revoked = await act({ action: 'code.revoke', ids: ['code:SPRING'] })
    expect(revoked.done).toEqual(['code:SPRING'])
    expect(revoked.undo).not.toBeNull()
    expect((await codeRow('SPRING'))?.revoked_at).toBe(now)
    const holds = async () =>
      (
        await first<{ n: number }>(
          api.db,
          sql`select count(*) as n from invite_redemptions where code = 'SPRING'`,
        )
      )?.n
    expect(await holds()).toBe(0)
    const [row] = await auditRows('code.revoke')
    expect(JSON.parse(row?.detail ?? '{}')).toEqual({
      from: { revokedAt: null },
      to: { revokedAt: now },
    })
    const listed = await invites('revoked')
    expect(listed.rows.map((r) => [r.id, r.actions])).toEqual([['code:SPRING', ['code.restore']]])
    expect((await act({ action: 'code.revoke', ids: ['code:SPRING'] })).failed[0]?.error).toBe(
      'not_applicable',
    )

    const back = await undo(revoked.undo?.group ?? '')
    expect(await back.json()).toEqual({ restored: 1 })
    expect((await codeRow('SPRING'))?.revoked_at).toBeNull()
    expect(await holds()).toBe(0)
    const detail = await get<AdminInviteDetail>('invites/code:SPRING')
    expect(detail.history.map((h) => h.action)).toEqual(['undo', 'code.revoke'])
  })

  test('restores a revoked code, and an undo revokes it again with its old stamp', async () => {
    await operatorCode('AUTUMN')
    await act({ action: 'code.revoke', ids: ['code:AUTUMN'] })
    const stamp = (await codeRow('AUTUMN'))?.revoked_at
    api.clock.advance(60_000)
    const restored = await act({ action: 'code.restore', ids: ['code:AUTUMN'] })
    expect(restored.done).toEqual(['code:AUTUMN'])
    expect((await codeRow('AUTUMN'))?.revoked_at).toBeNull()
    expect(
      (await act({ action: 'code.restore', ids: ['code:AUTUMN', 'code:NONE'] })).failed,
    ).toEqual([
      { id: 'code:AUTUMN', error: 'not_applicable' },
      { id: 'code:NONE', error: 'not_found' },
    ])
    // A hold placed while it was open goes with the revocation the undo brings back.
    await hold('AUTUMN', 'late@x.test')
    expect(await (await undo(restored.undo?.group ?? '')).json()).toEqual({ restored: 1 })
    expect((await codeRow('AUTUMN'))?.revoked_at).toBe(stamp ?? -1)
    expect((await invites('waiting')).rows).toEqual([])
  })

  test('refuses an undo once the code moved on, and restores nothing', async () => {
    await operatorCode('WINTER')
    const revoked = await act({ action: 'code.revoke', ids: ['code:WINTER'] })
    await act({ action: 'code.restore', ids: ['code:WINTER'] })
    const res = await undo(revoked.undo?.group ?? '')
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'changed_since' })
    expect((await codeRow('WINTER'))?.revoked_at).toBeNull()
  })

  test("revoking a member's unused code frees one of their five; a used one stays", async () => {
    const ann = await signedIn(api, 'ann@x.test')
    const codes: string[] = []
    for (let i = 0; i < INVITE_ALLOWANCE; i++) {
      const made = await createMemberCode(api.db, { userId: ann.userId, now: i })
      if (!made.ok) throw new Error('no code')
      codes.push(made.code)
    }
    const [usedCode, freed] = codes as [string, string]
    await joinWith(usedCode, 'bob@x.test')
    expect((await api.request('/api/v1/invites', { method: 'POST', as: ann })).status).toBe(409)

    const revoked = await act({ action: 'code.revoke', ids: [`code:${freed}`, `code:${usedCode}`] })
    expect(revoked.done).toEqual([`code:${freed}`])
    expect(revoked.failed).toEqual([{ id: `code:${usedCode}`, error: 'not_applicable' }])
    expect(await listMemberCodes(api.db, ann.userId)).toHaveLength(INVITE_ALLOWANCE - 1)
    const revokedRow = async () =>
      (await invites('revoked')).rows.find((r) => r.id === `code:${freed}`)
    expect((await revokedRow())?.actions).toEqual(['code.restore'])
    expect((await api.request('/api/v1/invites', { method: 'POST', as: ann })).status).toBe(200)

    // The place is spent again, so the code cannot come back: not by Restore, not by an undo.
    expect((await revokedRow())?.actions).toEqual([])
    expect((await act({ action: 'code.restore', ids: [`code:${freed}`] })).failed).toEqual([
      { id: `code:${freed}`, error: 'limit' },
    ])
    expect((await undo(revoked.undo?.group ?? '')).status).toBe(409)
    expect((await codeRow(freed))?.revoked_at).not.toBeNull()

    // With a place free again, it can.
    const spare = (await listMemberCodes(api.db, ann.userId)).find((c) => c.joinedAt === null)
    expect((await act({ action: 'code.revoke', ids: [`code:${spare?.code}`] })).done).toHaveLength(
      1,
    )
    expect((await act({ action: 'code.restore', ids: [`code:${freed}`] })).done).toEqual([
      `code:${freed}`,
    ])
    expect(await listMemberCodes(api.db, ann.userId)).toHaveLength(INVITE_ALLOWANCE)
  })

  test('lists codes, waiting and revoked, with each count under the search', async () => {
    const ann = await signedIn(api, 'ann@x.test')
    const annHandle = await handleOf(ann.userId)
    const member = await createMemberCode(api.db, { userId: ann.userId, now: 0 })
    if (!member.ok) throw new Error('no code')
    await operatorCode('ALPHA', 3)
    await operatorCode('BETA')
    await act({ action: 'code.revoke', ids: ['code:BETA'] })
    await hold('ALPHA', 'wait@x.test')
    await hold(member.code, 'other@x.test')

    const codes = await invites('codes')
    expect(codes.counts).toEqual({ codes: 2, waiting: 2, revoked: 1 })
    // The operator's first.
    expect(codes.rows.map((r) => r.id)).toEqual(['code:ALPHA', `code:${member.code}`])
    expect(codes.rows[0]).toMatchObject({
      type: 'code',
      code: 'ALPHA',
      createdBy: null,
      maxUses: 3,
      used: 0,
      holds: 1,
      revokedAt: null,
      joined: [],
    })
    expect(codes.rows[1]).toMatchObject({
      createdBy: { id: ann.userId, handle: annHandle },
      actions: ['code.revoke'],
    })

    expect((await invites('codes', 'alp')).counts).toEqual({ codes: 1, waiting: 1, revoked: 0 })
    expect((await invites('codes', annHandle)).rows.map((r) => r.id)).toEqual([
      `code:${member.code}`,
    ])
    // A member's code as it is shown, in groups, in lower case.
    const typed = groupInviteCode(member.code).slice(0, 9).toLowerCase()
    expect((await invites('codes', typed)).rows.map((r) => r.id)).toEqual([`code:${member.code}`])
    expect((await invites('waiting', 'wait@')).rows.map((r) => (r as AdminHoldRow).email)).toEqual([
      'wait@x.test',
    ])
    expect((await invites('revoked', 'beta')).rows.map((r) => r.id)).toEqual(['code:BETA'])
    expect((await api.request('/api/v1/admin/invites?f=pending', { as: ops })).status).toBe(400)

    // A record by its id, escaped or not.
    for (const path of ['invites/code:ALPHA', 'invites/code%3AALPHA']) {
      const detail = await get<AdminInviteDetail>(path)
      expect((detail.invite as AdminCodeRow).code).toBe('ALPHA')
    }
    for (const id of ['code:NONE', 'code:alpha', 'hold:0', 'hold:x', 'ALPHA']) {
      expect((await api.request(`/api/v1/admin/invites/${id}`, { as: ops })).status).toBe(404)
    }
  })

  test('cancels a hold, and audits it by its id, never the address', async () => {
    await operatorCode('GAMMA')
    const id = await hold('GAMMA', 'wait@x.test')
    const waiting = await invites('waiting')
    expect(waiting.rows).toEqual([
      {
        id: `hold:${id}`,
        actions: ['hold.cancel'],
        type: 'hold',
        redemptionId: id,
        email: 'wait@x.test',
        code: 'GAMMA',
        codeOwner: null,
        expiresAt: api.clock.now() + 24 * 3600_000,
        createdAt: api.clock.now(),
      },
    ])
    const detail = await get<AdminInviteDetail>(`invites/hold:${id}`)
    expect(detail).toEqual({ invite: waiting.rows[0] as AdminHoldRow, history: [] })

    expect(await act({ action: 'hold.cancel', ids: [`hold:${id}`] })).toEqual({
      done: [`hold:${id}`],
      failed: [],
      undo: null,
    })
    expect((await invites('waiting')).counts.waiting).toBe(0)
    const [row] = await auditRows('hold.cancel')
    expect(row).toMatchObject({ target_kind: 'hold', target_key: String(id) })
    expect(row?.detail).not.toContain('wait@')
    expect(JSON.parse(row?.detail ?? '{}')).toEqual({
      from: { code: 'GAMMA', expiresAt: api.clock.now() + 24 * 3600_000 },
      to: null,
    })
    expect(
      (await act({ action: 'hold.cancel', ids: [`hold:${id}`, 'code:GAMMA'] })).failed,
    ).toEqual([
      { id: `hold:${id}`, error: 'not_found' },
      { id: 'code:GAMMA', error: 'not_found' },
    ])
    // The address can no longer be mailed a code with it.
    const before = api.mail.outbox.length
    await api.request('/api/auth/email-otp/send-verification-otp', {
      body: { email: 'wait@x.test', type: 'sign-in' },
      headers: { 'cf-connecting-ip': ip() },
    })
    expect(api.mail.outbox.length).toBe(before)
  })
})

describe('inviting an address', () => {
  test('makes the account, mails it a code, and audits the member, not the address', async () => {
    const answer = await act({ action: 'invite.address', ids: [], args: { email: ' New@X.test ' } })
    expect(answer).toEqual({ done: [''], failed: [], undo: null })
    const user = await first<{ id: string }>(
      api.db,
      sql`select id from user where email = 'new@x.test'`,
    )
    expect(user).toBeDefined()
    expect(codeFor(api, 'new@x.test')).toMatch(/^\d{6}$/)
    const [row] = await auditRows('invite.address')
    expect(row).toMatchObject({ target_kind: 'member', target_key: user?.id })
    expect(row?.detail).not.toContain('new@')
    expect(JSON.parse(row?.detail ?? '{}')).toEqual({ from: null, to: { created: true } })

    // An address with an account is only mailed again.
    const mails = api.mail.outbox.length
    expect(
      (await act({ action: 'invite.address', ids: [], args: { email: 'new@x.test' } })).done,
    ).toEqual([''])
    expect(api.mail.outbox.length).toBe(mails + 1)
    expect(JSON.parse((await auditRows('invite.address'))[1]?.detail ?? '{}')).toEqual({
      from: null,
      to: { created: false },
    })
    const person = (await people('members')).rows.find((r) => r.userId === user?.id)
    expect(person?.invitedBy).toEqual({ kind: 'operator' })

    for (const args of [{ email: 'not-an-address' }, {}]) {
      expect(await act({ action: 'invite.address', ids: [], args })).toMatchObject({
        failed: [{ id: '', error: 'invalid' }],
      })
    }

    // Each invitation mails a sign-in code, held to the address's limit like any other: five an
    // hour, the two above included, then a refusal and no mail.
    const invite = () => act({ action: 'invite.address', ids: [], args: { email: 'new@x.test' } })
    for (let i = 0; i < 3; i++) expect((await invite()).done).toEqual([''])
    const sent = api.mail.outbox.length
    expect(await invite()).toMatchObject({ done: [], failed: [{ id: '', error: 'limit' }] })
    expect(api.mail.outbox.length).toBe(sent)
    // It names no target.
    const named = await api.request('/api/v1/admin/act', {
      as: ops,
      body: { action: 'invite.address', ids: ['x'], args: { email: 'x@x.test' } },
    })
    expect(named.status).toBe(400)
  })

  test('the token route still invites as it did', async () => {
    const invite = (body: unknown, token = ADMIN_TOKEN) =>
      api.request('/api/admin/invite', { body, headers: { authorization: `Bearer ${token}` } })
    const first = await invite({ email: 'Tok@X.test' })
    expect(first.status).toBe(200)
    const made = (await first.json()) as { userId: string; created: boolean }
    expect(made).toEqual({ userId: expect.any(String), created: true })
    expect(codeFor(api, 'tok@x.test')).toMatch(/^\d{6}$/)
    expect(await (await invite({ email: 'tok@x.test' })).json()).toEqual({
      userId: made.userId,
      created: false,
    })
    const bad = await invite({ email: 'nope' })
    expect(bad.status).toBe(400)
    expect(await bad.json()).toEqual({ error: 'invalid_email' })
    expect((await invite({ email: 'x@x.test' }, 'wrong')).status).toBe(403)
    // The token route leaves no audit row: it is the operator's, not the console's.
    expect(await auditRows('invite.address')).toEqual([])
  })
})

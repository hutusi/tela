/**
 * Leaving Tela (ADR 0058), through the real tela-api: a member who follows and is followed, likes,
 * recommends, keeps blogrolls, highlights, folders and subscriptions, claimed a blog and invited
 * someone deletes their account. Their tabs are refused from the next call; another member's
 * device, after a pull, holds nothing of theirs; the server keeps no personal data of theirs,
 * table by table, once `member.erase` has run; and what others did stays theirs.
 */
import { beforeEach, describe, expect, test } from 'bun:test'
import {
  backUp,
  bumpSeq,
  CLOSURES_PREFIX,
  currentSeq,
  ERASE_CHUNK,
  ERASE_STEPS,
  finishErasure,
  first,
  reapplyClosures,
  restoreDatabase,
  type TelaDb,
} from '@tela/data'
import { createTestDb } from '@tela/data/testing'
import { memoryBlobs } from '@tela/platform/portable'
import { applyPull, type Confirmed, emptyTables, type PullResponse } from '@tela/sync'
import { sql } from 'drizzle-orm'
import {
  ADMIN_TOKEN,
  codeFor,
  cookiesOf,
  createTestApi,
  type SignedIn,
  signedIn,
  type TestApi,
} from './helpers'

type Row = Record<string, unknown>

const HANDLE = 'ada_leaves'
/** Everything of Ada's own words and choices, none of which may be left anywhere. */
const SECRETS = {
  email: 'ada@x.test',
  name: 'Ada Lovelace-Secret',
  bio: 'A bio only Ada wrote',
  note: 'a note only Ada wrote',
  blogroll: 'Ada blogroll name',
  blurb: 'Ada blogroll description',
  blogNote: 'why Ada rolled it',
  quote: 'Ada quote',
  highlightNote: 'Ada highlight note',
  folder: 'Ada folder',
  pref: 'ada-pref-value',
}
const CONTENT = 'a'.repeat(32)

let api: TestApi
let db: TelaDb
let ada: SignedIn
let bo: SignedIn
let cy: SignedIn
let mids = 0

const write = (...statements: ReturnType<TelaDb['run']>[]) =>
  db.batch([bumpSeq(db), ...statements] as never)

async function push(who: SignedIn, ...mutations: Record<string, unknown>[]) {
  const res = await api.request('/api/v1/mutations', {
    as: who,
    body: {
      mutations: mutations.map((m) => ({
        mid: `leave-mid-${++mids}-pad`,
        at: api.clock.now(),
        ...m,
      })),
    },
  })
  expect(res.status).toBe(200)
  const body = (await res.json()) as { rejected: unknown[] }
  expect(body.rejected).toEqual([])
}

/** A device: what a pull at a time has given it, folded by the client's own reducer. */
async function pull(who: SignedIn, device: Confirmed): Promise<Confirmed> {
  let held = device
  for (;;) {
    const res = await api.request(`/api/v1/sync?cursor=${held.cursor}`, { as: who })
    expect(res.status).toBe(200)
    const body = (await res.json()) as PullResponse
    held = applyPull(held, body)
    if (!body.more) return held
  }
}

/** `member.erase`'s steps to their end, then its last batch (tela-jobs runs them fenced). */
async function erase(userId: string): Promise<boolean> {
  const now = api.clock.now()
  for (const step of ERASE_STEPS) {
    for (;;) {
      const chunk = step(db, userId, now)
      const results = (await db.batch([
        bumpSeq(db),
        ...chunk.statements,
      ] as never)) as unknown as unknown[][]
      if ((results[1 + chunk.counted] ?? []).length < ERASE_CHUNK) break
    }
  }
  const done = (await db.batch([
    bumpSeq(db),
    ...finishErasure(db, userId, now),
  ] as never)) as unknown as unknown[][]
  return (done.at(-1) ?? []).length > 0
}

/** Every row of every table, as text. */
async function everything(): Promise<Record<string, string>> {
  const tables = await db.all<{ name: string }>(sql`
    select name from sqlite_master where type = 'table' and name not like 'sqlite_%' order by name
  `)
  const out: Record<string, string> = {}
  for (const { name } of tables) {
    out[name] = JSON.stringify(await db.all(sql.raw(`select * from "${name}"`)))
  }
  return out
}

/** Ask for the deletion code, then delete with it: what Settings does. */
async function deleteAccount(who: SignedIn, email: string) {
  const asked = await api.request('/api/v1/account/delete/code', { as: who, body: {} })
  expect(asked.status).toBe(200)
  return api.request('/api/v1/account/delete', { as: who, body: { code: codeFor(api, email) } })
}

beforeEach(async () => {
  api = await createTestApi()
  db = api.db
  ada = await signedIn(api, SECRETS.email)
  bo = await signedIn(api, 'bo@x.test')
  cy = await signedIn(api, 'cy@x.test')
  const now = api.clock.now()
  await write(
    db.run(sql`insert into sites (id, home_url, title, listing, claimed_by, claimed_at,
        translation_opt_out, created_at, updated_at, seq)
      values (1, 'https://ada.example', 'Ada writes', 'listed', ${ada.userId}, 0, 1, 0, 0,
          ${currentSeq}),
        (2, 'https://other.example', 'Other', 'listed', null, null, 0, 0, 0, ${currentSeq})`),
    db.run(sql`insert into feeds (id, site_id, feed_url, host, next_fetch_at, added_by, created_at,
        updated_at, seq)
      values (1, 1, 'https://ada.example/feed', 'ada.example', 0, ${ada.userId}, 0, 0, ${currentSeq}),
        (2, 2, 'https://other.example/feed', 'other.example', 0, null, 0, 0, ${currentSeq})`),
    db.run(sql`insert into articles (id, feed_id, dedup_key, url, title, fetched_at, sort_at,
        content_key, seq)
      values (1, 1, 'k1', 'https://ada.example/1', 'One', ${now}, ${now}, ${CONTENT}, ${currentSeq}),
        (2, 2, 'k2', 'https://other.example/2', 'Two', ${now}, ${now}, null, ${currentSeq})`),
    db.run(sql`insert into site_claims (id, site_id, user_id, method, token, status, verified_at,
        created_at, seq)
      values (1, 1, ${ada.userId}, 'meta', 't', 'verified', 0, 0, ${currentSeq})`),
    // Ada invited Cy, with a code of Ada's.
    db.run(sql`insert into invite_codes (code, created_by, max_uses, created_at)
      values ('ADAADAADAADA', ${ada.userId}, 1, 0)`),
    db.run(sql`insert into invite_redemptions (code, email, expires_at, redeemed_at, user_id,
        settled_at, created_at)
      values ('ADAADAADAADA', 'cy@x.test', 0, 0, ${cy.userId}, 0, 0)`),
  )
  const put = await api.request('/api/v1/profile', {
    method: 'PUT',
    as: ada,
    body: { handle: HANDLE, displayName: SECRETS.name, bio: SECRETS.bio },
  })
  expect(put.status).toBe(200)
  await push(
    ada,
    { type: 'subscribe', feedId: 1 },
    { type: 'subscribe', feedId: 2 },
    { type: 'setLiked', articleId: 1, liked: true },
    { type: 'setLiked', articleId: 2, liked: true },
    { type: 'recommend', articleId: 1, note: SECRETS.note },
    { type: 'follow', userId: bo.userId },
    { type: 'setPrivacy', publicLikes: true, publicSubscriptions: true },
    { type: 'setPref', key: 'reader.secret', value: SECRETS.pref },
    { type: 'putFolder', id: 'folder-ada-0001', name: SECRETS.folder },
    { type: 'fileFeed', feedId: 2, folderId: 'folder-ada-0001' },
    {
      type: 'putBlogroll',
      id: 'AdaRoll00001',
      name: SECRETS.blogroll,
      description: SECRETS.blurb,
      isPublic: true,
    },
    { type: 'rollBlog', blogrollId: 'AdaRoll00001', feedId: 2 },
    { type: 'noteBlog', blogrollId: 'AdaRoll00001', feedId: 2, note: SECRETS.blogNote },
    {
      type: 'putHighlight',
      id: 'highlight-ada-01',
      articleId: 1,
      contentKey: CONTENT,
      side: 'original',
      lang: null,
      leafId: 'b1',
      start: 0,
      end: SECRETS.quote.length,
      quote: SECRETS.quote,
      prefix: '',
      suffix: '',
      note: SECRETS.highlightNote,
    },
  )
  await push(
    bo,
    { type: 'subscribe', feedId: 1 },
    { type: 'setLiked', articleId: 1, liked: true },
    { type: 'follow', userId: ada.userId },
  )
})

describe('deleting an account', () => {
  test("another member's device holds nothing of theirs after a pull, and the counts drop", async () => {
    let device: Confirmed = { cursor: 0, tables: emptyTables() }
    device = await pull(bo, device)
    expect([...device.tables.follows.keys()]).toEqual([ada.userId])
    expect(device.tables.follows.get(ada.userId)?.displayName).toBe(SECRETS.name)
    expect(device.tables.articles.get(1)).toMatchObject({ likeCount: 2, recommendCount: 1 })
    expect(device.tables.sites.get(1)).toMatchObject({ claimed: true })

    expect((await deleteAccount(ada, SECRETS.email)).status).toBe(200)
    device = await pull(bo, device)
    expect(device.tables.follows.size).toBe(0)
    expect(device.tables.sites.get(1)).toMatchObject({ claimed: false })

    // The counts others see drop once `member.erase` has run, ten minutes on.
    expect(await erase(ada.userId)).toBe(true)
    device = await pull(bo, device)
    expect(device.tables.articles.get(1)).toMatchObject({ likeCount: 1, recommendCount: 0 })
    const held = JSON.stringify({
      ...device.tables,
      ...Object.fromEntries(
        Object.entries(device.tables).map(([k, v]) => [k, v instanceof Map ? [...v.values()] : v]),
      ),
    })
    expect(held).not.toContain(ada.userId)
    for (const secret of Object.values(SECRETS)) expect(held).not.toContain(secret)
  })

  test('the server keeps nothing of theirs but an empty account and its handle', async () => {
    expect((await deleteAccount(ada, SECRETS.email)).status).toBe(200)
    expect(await erase(ada.userId)).toBe(true)
    const tables = await everything()
    for (const [name, rows] of Object.entries(tables)) {
      for (const [what, secret] of Object.entries(SECRETS)) {
        if (rows.includes(secret)) throw new Error(`${name} still holds Ada's ${what}`)
      }
    }
    // What still names the account by its id: the shells, the follow of it (deleted, for Bo's
    // device), the invitation it joined by and the code it gave Cy, and the audit row.
    const naming = Object.entries(tables)
      .filter(([, rows]) => rows.includes(ada.userId))
      .map(([name]) => name)
      .sort()
    expect(naming).toEqual([
      'admin_actions',
      'follows',
      'invite_codes',
      'invite_redemptions',
      'profiles',
      'user',
    ])
    expect(
      await first<Row>(db, sql`select follower_id, deleted_at is not null as gone from follows`),
    ).toEqual({ follower_id: bo.userId, gone: 1 })
    expect(
      await first<Row>(
        db,
        sql`select handle, display_name, deleted_at is not null as closed,
        erased_at is not null as erased from profiles where user_id = ${ada.userId}`,
      ),
    ).toEqual({ handle: HANDLE, display_name: null, closed: 1, erased: 1 })
    expect(
      await first<Row>(db, sql`select like_count, recommend_count from articles where id = 1`),
    ).toEqual({ like_count: 1, recommend_count: 0 })
    expect(await first<Row>(db, sql`select reader_count from sites where id = 1`)).toEqual({
      reader_count: 1,
    })
  })

  test("signs out every tab: the asking browser's cookies, and every other's next call", async () => {
    const res = await deleteAccount(ada, SECRETS.email)
    expect(await res.json()).toEqual({ deleted: true })
    const cleared = res.headers.getSetCookie()
    expect(cleared.some((c) => c.startsWith('tela.session_token=;') && /Max-Age=0/i.test(c))).toBe(
      true,
    )
    // A tab elsewhere still sends the old cookie, its signed copy of the session included.
    for (const [path, init] of [
      ['/api/v1/me', {}],
      ['/api/v1/sync?cursor=0', {}],
      ['/api/v1/export', {}],
      ['/api/v1/mutations', { body: { mutations: [] } }],
      ['/api/v1/profile', { method: 'PUT', body: { bio: 'back' } }],
    ] as const) {
      const again = await api.request(path, { as: ada, ...init })
      expect([path, again.status]).toEqual([path, 401])
    }
    // Nobody can sign in to it: the address is gone, so no code is mailed to it.
    const before = api.mail.outbox.length
    await api.request('/api/auth/email-otp/send-verification-otp', {
      body: { email: SECRETS.email, type: 'sign-in' },
    })
    expect(api.mail.outbox.length).toBe(before)
  })

  test("leaves what others did theirs: Cy's invitation, and the handle stays taken", async () => {
    expect((await deleteAccount(ada, SECRETS.email)).status).toBe(200)
    expect(
      await first<Row>(
        db,
        sql`select email, user_id from invite_redemptions
        where code = 'ADAADAADAADA'`,
      ),
    ).toEqual({ email: 'cy@x.test', user_id: cy.userId })
    expect((await api.request('/api/v1/me', { as: cy })).status).toBe(200)
    const taken = await api.request('/api/v1/profile', {
      method: 'PUT',
      as: cy,
      body: { handle: HANDLE },
    })
    expect(taken.status).toBe(409)
    // A follow of it queued on a device offline as it closed writes nothing.
    await push(cy, { type: 'follow', userId: ada.userId })
    expect(
      await first<Row>(db, sql`select count(*) as n from follows where follower_id = ${cy.userId}`),
    ).toEqual({ n: 0 })
  })

  test('takes the code just mailed, three tries of it, and refuses an admin', async () => {
    const asked = await api.request('/api/v1/account/delete/code', { as: ada, body: {} })
    expect(asked.status).toBe(200)
    const mail = api.mail.outbox.at(-1)
    expect(mail?.to).toBe(SECRETS.email)
    expect(mail?.subject).toMatch(/^Your code to delete your Tela account · .+: \d{6}$/)
    const code = codeFor(api, SECRETS.email)
    const wrong = code === '000000' ? '111111' : '000000'
    for (let i = 0; i < 2; i++) {
      const tried = await api.request('/api/v1/account/delete', { as: ada, body: { code: wrong } })
      expect(tried.status).toBe(400)
      expect(await tried.json()).toEqual({ error: 'invalid_code' })
    }
    // The third try is the last the code takes, right or not.
    expect(
      (await api.request('/api/v1/account/delete', { as: ada, body: { code: wrong } })).status,
    ).toBe(400)
    expect((await api.request('/api/v1/account/delete', { as: ada, body: { code } })).status).toBe(
      400,
    )
    expect((await api.request('/api/v1/me', { as: ada })).status).toBe(200)

    // An admin is ungranted first.
    await api.request('/api/admin/admins', {
      body: { email: SECRETS.email, admin: true },
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    })
    const admin = await api.request('/api/v1/account/delete/code', { as: ada, body: {} })
    expect(admin.status).toBe(403)
    expect(await admin.json()).toEqual({ error: 'admin' })
  })

  test('writes a closure, which a restore from an older backup re-applies', async () => {
    const backups = memoryBlobs()
    await backUp(db, backups, { date: '2026-09-28', now: () => api.clock.now() })
    expect((await deleteAccount(ada, SECRETS.email)).status).toBe(200)
    expect((await api.blobs.list({ prefix: CLOSURES_PREFIX })).keys).toEqual([
      `${CLOSURES_PREFIX}${ada.userId}`,
    ])
    const { db: restored } = await createTestDb()
    await restoreDatabase(restored, backups, '2026-09-28')
    const open = sql`select email, deleted_at is not null as closed from user u
      join profiles p on p.user_id = u.id where u.id = ${ada.userId}`
    expect(await first<Row>(restored, open)).toEqual({ email: SECRETS.email, closed: 0 })
    expect(await reapplyClosures(restored, api.blobs, api.clock.now())).toEqual({
      closures: 1,
      closed: 1,
    })
    expect(await first<Row>(restored, open)).toEqual({
      email: `deleted+${ada.userId}@deleted.invalid`,
      closed: 1,
    })
    // Again, nothing changes.
    expect(await reapplyClosures(restored, api.blobs, api.clock.now())).toEqual({
      closures: 1,
      closed: 0,
    })
  })

  test("the operator's `bun run admin closures` re-applies them on the live database", async () => {
    expect((await deleteAccount(ada, SECRETS.email)).status).toBe(200)
    const reapply = (headers: Record<string, string>) =>
      api.request('/api/admin/closures', { body: {}, headers })
    expect((await reapply({})).status).toBe(403)
    const res = await reapply({ authorization: `Bearer ${ADMIN_TOKEN}` })
    // Closed already, so nothing closes again; after a rollback the same call closes it.
    expect(await res.json()).toEqual({ closures: 1, closed: 0 })
  })
})

describe('an account out of good standing', () => {
  test('cannot sign in, whichever way, and is signed out on its next call', async () => {
    await db.run(sql`update profiles set suspended_at = 1 where user_id = ${cy.userId}`)
    expect((await api.request('/api/v1/sync?cursor=0', { as: cy })).status).toBe(401)
    // From an address of its own: better-auth allows three sign-ins a minute per IP.
    const ip = { 'cf-connecting-ip': '198.51.100.7' }
    await api.request('/api/auth/email-otp/send-verification-otp', {
      body: { email: 'cy@x.test', type: 'sign-in' },
      headers: ip,
    })
    const signIn = await api.request('/api/auth/sign-in/email-otp', {
      body: { email: 'cy@x.test', otp: codeFor(api, 'cy@x.test') },
      headers: ip,
    })
    expect(signIn.status).toBe(403)
    expect(await signIn.json()).toMatchObject({ code: 'ACCOUNT_SUSPENDED' })
    expect(cookiesOf(signIn)).not.toContain('session_token=')
  })
})

describe('releasing a blog', () => {
  test('only its claimant may, and its opt-outs stay as they set them', async () => {
    expect((await api.request('/api/v1/claims/1/release', { as: bo, body: {} })).status).toBe(404)
    const res = await api.request('/api/v1/claims/1/release', { as: ada, body: {} })
    expect(await res.json()).toEqual({ released: true })
    expect(
      await first<Row>(
        db,
        sql`select claimed_by, translation_opt_out, listing from sites where id = 1`,
      ),
    ).toEqual({ claimed_by: null, translation_opt_out: 1, listing: 'private' })
    expect(await first<Row>(db, sql`select status, error, overruled_at from site_claims`)).toEqual({
      status: 'failed',
      error: 'released by its claimant',
      overruled_at: null,
    })
    expect((await api.request('/api/v1/claims/1/release', { as: ada, body: {} })).status).toBe(404)
  })
})

describe('the export', () => {
  test('carries claims, codes and who joined by them, the invitation, reads and the picture', async () => {
    await push(ada, { type: 'markRead', articleId: 2 }, { type: 'markUnread', articleId: 1 })
    await db.run(sql`update profiles set avatar_key = 'avatars/x.png', avatar_version = 3
      where user_id = ${ada.userId}`)
    const res = await api.request('/api/v1/export', { as: ada })
    const body = (await res.json()) as Record<string, unknown>
    expect(body.claims).toEqual([
      {
        blog: 'https://ada.example',
        title: 'Ada writes',
        status: 'verified',
        method: 'meta',
        askedAt: 0,
        verifiedAt: 0,
      },
    ])
    const cyHandle = await first<{ handle: string }>(
      db,
      sql`select handle from profiles where user_id = ${cy.userId}`,
    )
    expect(body.inviteCodes).toEqual([
      {
        code: 'ADAADAADAADA',
        createdAt: 0,
        revokedAt: null,
        joined: [{ handle: cyHandle?.handle, joinedAt: 0 }],
      },
    ])
    expect(body.joinedBy).toMatchObject({ code: null, invitedBy: null })
    // Both at one instant here, so by post.
    expect(body.reads).toMatchObject([
      { url: 'https://ada.example/1', readAt: null, markedUnread: true },
      { url: 'https://other.example/2', readAt: api.clock.now(), markedUnread: false },
    ])
    expect((body.profile as { picture: string }).picture).toBe(
      `http://tela.test/avatar/${ada.userId}?v=3`,
    )
    // Never another person's address.
    expect(JSON.stringify(body)).not.toContain('cy@x.test')
  })
})

describe("an operator's member.delete", () => {
  const act = (who: SignedIn, id: string) =>
    api.request('/api/v1/admin/act', {
      as: who,
      body: { action: 'member.delete', ids: [id] },
    })

  test('is refused for an admin and for oneself, and closes anyone else', async () => {
    await api.request('/api/admin/admins', {
      body: { email: 'bo@x.test', admin: true },
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    })
    await api.request('/api/admin/admins', {
      body: { email: 'cy@x.test', admin: true },
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    })
    for (const id of [bo.userId, cy.userId]) {
      expect(await (await act(bo, id)).json()).toEqual({
        done: [],
        failed: [{ id, error: 'not_applicable' }],
        undo: null,
      })
    }
    expect((await api.blobs.list({ prefix: CLOSURES_PREFIX })).keys).toEqual([])
    expect(await (await act(bo, ada.userId)).json()).toEqual({
      done: [ada.userId],
      failed: [],
      undo: null,
    })
    expect(
      await first<Row>(
        db,
        sql`select actor_id, action from admin_actions where target_key = ${ada.userId}`,
      ),
    ).toEqual({ actor_id: bo.userId, action: 'member.delete' })
    expect((await api.request('/api/v1/me', { as: ada })).status).toBe(401)
    expect((await api.blobs.list({ prefix: CLOSURES_PREFIX })).keys).toHaveLength(1)
    // Closed, it is not offered again.
    expect(await (await act(bo, ada.userId)).json()).toMatchObject({
      failed: [{ id: ada.userId, error: 'not_applicable' }],
    })
  })
})

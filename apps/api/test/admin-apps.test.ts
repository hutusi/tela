/**
 * The console's Apps area (ADRs 0039, 0064): registering an app, approving it, cutting it off and
 * restoring it, editing what it may do, and ending every connection to it; each audited, and
 * every action but the last with an undo. An audit row never holds the developer's address.
 */
import { beforeEach, describe, expect, test } from 'bun:test'
import { first } from '@tela/data'
import { CLIENT_ID_PREFIX } from '@tela/shared'
import type {
  AdminActResponse,
  AdminAppDetail,
  AdminAppRow,
  AdminAppSettings,
  AdminList,
} from '@tela/shared/admin'
import { sql } from 'drizzle-orm'
import { parseAct } from '../src/routes/admin'
import { ADMIN_TOKEN, createTestApi, type SignedIn, signedIn, type TestApi } from './helpers'

let api: TestApi
let ops: SignedIn

beforeEach(async () => {
  api = await createTestApi()
  ops = await signedIn(api, 'ops@x.test')
  const granted = await api.request('/api/admin/admins', {
    body: { email: 'ops@x.test', admin: true },
    headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
  })
  expect(granted.status).toBe(200)
})

const settings = (over: Partial<AdminAppSettings> = {}): AdminAppSettings => ({
  name: 'Loom',
  developer: 'Loom Labs',
  contactEmail: 'dev@loom.example',
  homepageUrl: 'https://loom.example',
  privacyUrl: 'https://loom.example/privacy',
  redirectUris: ['http://127.0.0.1/callback'],
  maxScope: 'write',
  allowEmail: false,
  owner: null,
  perMemberPerMin: null,
  perAppPerMin: null,
  maxConnections: null,
  ...over,
})

const act = async (body: unknown, as = ops) => {
  const res = await api.request('/api/v1/admin/act', { as, body })
  expect(res.status).toBe(200)
  return (await res.json()) as AdminActResponse
}

const undo = (group: string) => api.request('/api/v1/admin/undo', { as: ops, body: { group } })

async function get<T>(path: string): Promise<T> {
  const res = await api.request(`/api/v1/admin/${path}`, { as: ops })
  expect(res.status).toBe(200)
  return (await res.json()) as T
}

const apps = (f: string) => get<AdminList<AdminAppRow, 'apps'>>(`apps?f=${f}`)

/** Register an app and give back its id. */
async function register(over: Partial<AdminAppSettings> = {}): Promise<string> {
  const before = new Set((await apps('draft')).rows.map((r) => r.id))
  const made = await act({ action: 'app.create', ids: [], args: { app: settings(over) } })
  expect(made).toEqual({ done: [''], failed: [], undo: null })
  const row = (await apps('draft')).rows.find((r) => !before.has(r.id))
  if (!row) throw new Error('no app registered')
  return row.id
}

const appRow = (id: string) =>
  first<{
    status: string
    approved_at: number | null
    suspended_at: number | null
    name: string
    contact_email: string
    max_scope: string
    redirect_uris: string
    owner_user_id: string | null
  }>(
    api.db,
    sql`select status, approved_at, suspended_at, name, contact_email, max_scope, redirect_uris,
      owner_user_id from apps where id = ${Number(id)}`,
  )

/** A member connected to the app, on one device. */
async function connect(appId: string, userId: string): Promise<number> {
  const now = api.clock.now()
  const [grant] = await api.db.all<{ id: number }>(sql`
    insert into app_grants (app_id, user_id, scope, created_at, updated_at, last_used_at)
    values (${Number(appId)}, ${userId}, 'read', ${now}, ${now}, ${now}) returning id
  `)
  if (!grant) throw new Error('no grant')
  await api.db.run(sql`
    insert into app_tokens (grant_id, scope, access_hash, access_expires_at, refresh_hash,
      created_at)
    values (${grant.id}, 'read', ${`a-${grant.id}`}, ${now + 3_600_000}, ${`r-${grant.id}`},
      ${now})
  `)
  return grant.id
}

describe('registering', () => {
  test('makes a draft with a client id of its own, listed with what can be done to it', async () => {
    const id = await register({ redirectUris: ['http://127.0.0.1/cb', 'com.loom.app:/oauth'] })
    const list = await apps('draft')
    expect(list.counts).toEqual({ approved: 0, draft: 1, suspended: 0 })
    const row = list.rows[0]
    expect(row).toMatchObject({
      id,
      name: 'Loom',
      developer: 'Loom Labs',
      contactEmail: 'dev@loom.example',
      status: 'draft',
      maxScope: 'write',
      allowEmail: false,
      redirectUris: ['http://127.0.0.1/cb', 'com.loom.app:/oauth'],
      owner: null,
      connections: 0,
      lastUsedAt: null,
      // No connections yet, so nothing to end.
      actions: ['app.approve', 'app.edit', 'app.suspend'],
    })
    expect(row?.clientId.startsWith(CLIENT_ID_PREFIX)).toBe(true)
    const detail = await get<AdminAppDetail>(`apps/${id}`)
    expect(detail.app.clientId).toBe(row?.clientId ?? '')
    expect(detail.history.map((h) => h.action)).toEqual(['app.create'])
  })

  test('names its owner by handle: the account a draft connects for', async () => {
    const mara = await signedIn(api, 'mara@x.test')
    const handle = (
      await first<{ handle: string }>(
        api.db,
        sql`select handle from profiles where user_id = ${mara.userId}`,
      )
    )?.handle
    const id = await register({ owner: `@${handle}` })
    expect((await appRow(id))?.owner_user_id).toBe(mara.userId)
    expect((await get<AdminAppDetail>(`apps/${id}`)).app.owner).toMatchObject({
      id: mara.userId,
      handle,
    })
    // Nobody by that handle: refused, and nothing registered.
    const refused = await act({
      action: 'app.create',
      ids: [],
      args: { app: settings({ owner: 'nobody_here' }) },
    })
    expect(refused.failed).toEqual([{ id: '', error: 'invalid' }])
  })

  test('refuses what no app may register, and never takes a target', async () => {
    for (const over of [
      { redirectUris: ['http://localhost/cb'] },
      { redirectUris: ['https://loom.example/cb'] },
      { homepageUrl: 'javascript:alert(1)' },
      { name: '' },
      { contactEmail: 'nobody' },
    ] satisfies Partial<AdminAppSettings>[]) {
      const res = await act({ action: 'app.create', ids: [], args: { app: settings(over) } })
      expect({ over, failed: res.failed }).toEqual({ over, failed: [{ id: '', error: 'invalid' }] })
    }
    expect((await apps('draft')).counts.draft).toBe(0)
    const named = await api.request('/api/v1/admin/act', {
      as: ops,
      body: { action: 'app.create', ids: ['7'], args: { app: settings() } },
    })
    expect(named.status).toBe(400)
    expect(parseAct({ action: 'app.create', ids: [], args: { app: 'Loom' } })).toBeNull()
    expect(parseAct({ action: 'app.create', ids: [], args: { app: [] } })).toBeNull()
  })

  test('keeps the developer’s address out of the audit log', async () => {
    const id = await register()
    await act({ action: 'app.edit', ids: [id], args: { app: settings({ name: 'Loom 2' }) } })
    const rows = await api.db.all<{ detail: string }>(
      sql`select detail from admin_actions where target_kind = 'app'`,
    )
    expect(rows).toHaveLength(2)
    for (const row of rows) expect(row.detail).not.toContain('dev@loom.example')
  })

  test('is the console’s alone: a member who is no admin is refused', async () => {
    const ann = await signedIn(api, 'ann@x.test')
    const res = await api.request('/api/v1/admin/act', {
      as: ann,
      body: { action: 'app.create', ids: [], args: { app: settings() } },
    })
    expect(res.status).toBe(403)
    expect((await api.request('/api/v1/admin/apps', { as: ann })).status).toBe(403)
  })
})

describe('the list', () => {
  test('is searched by name, developer, client id or address, posted', async () => {
    await register()
    await register({ name: 'Weft', developer: 'Weft Co', contactEmail: 'hi@weft.example' })
    const search = async (q: string) => {
      const res = await api.request('/api/v1/admin/apps', { as: ops, body: { f: 'draft', q } })
      expect(res.status).toBe(200)
      return ((await res.json()) as AdminList<AdminAppRow, 'apps'>).rows.map((r) => r.name)
    }
    expect(await search('weft.example')).toEqual(['Weft'])
    expect(await search('LOOM LABS')).toEqual(['Loom'])
    expect((await search('tela_app_')).sort()).toEqual(['Loom', 'Weft'])
    expect(await search('%')).toEqual([])
    expect((await api.request('/api/v1/admin/apps?f=live', { as: ops })).status).toBe(400)
    expect((await api.request('/api/v1/admin/apps/abc', { as: ops })).status).toBe(404)
  })
})

describe('where an app stands', () => {
  test('approve, cut off and restore, each with an undo', async () => {
    const id = await register()
    const approved = await act({ action: 'app.approve', ids: [id] })
    expect(approved.done).toEqual([id])
    expect(await appRow(id)).toMatchObject({ status: 'approved', approved_at: expect.any(Number) })
    expect((await apps('approved')).rows[0]?.actions).toEqual(['app.edit', 'app.suspend'])

    const cut = await act({ action: 'app.suspend', ids: [id] })
    expect(await appRow(id)).toMatchObject({
      status: 'suspended',
      suspended_at: expect.any(Number),
    })
    expect((await apps('suspended')).rows[0]?.actions).toEqual(['app.restore', 'app.edit'])
    // Cut off already: nothing to change.
    expect((await act({ action: 'app.suspend', ids: [id] })).failed).toEqual([
      { id, error: 'not_applicable' },
    ])

    // Undoing the cut-off puts it back where it stood: approved.
    expect((await undo(cut.undo?.group ?? '')).status).toBe(200)
    expect(await appRow(id)).toMatchObject({ status: 'approved', suspended_at: null })

    await act({ action: 'app.suspend', ids: [id] })
    const restored = await act({ action: 'app.restore', ids: [id] })
    expect(await appRow(id)).toMatchObject({ status: 'approved', suspended_at: null })
    expect((await undo(restored.undo?.group ?? '')).status).toBe(200)
    expect((await appRow(id))?.status).toBe('suspended')

    // Undoing the approval, which a later cut-off stands in the way of.
    const late = await undo(approved.undo?.group ?? '')
    expect(late.status).toBe(409)
  })

  test('a draft cut off goes back to being a draft, and an approval undone to one', async () => {
    const id = await register()
    await act({ action: 'app.suspend', ids: [id] })
    await act({ action: 'app.restore', ids: [id] })
    expect(await appRow(id)).toMatchObject({ status: 'draft', approved_at: null })
    const approved = await act({ action: 'app.approve', ids: [id] })
    expect((await undo(approved.undo?.group ?? '')).status).toBe(200)
    expect(await appRow(id)).toMatchObject({ status: 'draft', approved_at: null })
    expect((await act({ action: 'app.restore', ids: [id] })).failed).toEqual([
      { id, error: 'not_applicable' },
    ])
    expect((await act({ action: 'app.approve', ids: ['999'] })).failed).toEqual([
      { id: '999', error: 'not_found' },
    ])
  })
})

describe('editing', () => {
  test('changes what it may do; the undo puts it back, but for the address', async () => {
    const id = await register()
    const edited = await act({
      action: 'app.edit',
      ids: [id],
      args: {
        app: settings({
          name: 'Loom Desktop',
          maxScope: 'read',
          contactEmail: 'new@loom.example',
          redirectUris: ['com.loom.desktop:/oauth'],
        }),
      },
    })
    expect(edited.done).toEqual([id])
    expect(await appRow(id)).toMatchObject({
      name: 'Loom Desktop',
      max_scope: 'read',
      contact_email: 'new@loom.example',
      redirect_uris: '["com.loom.desktop:/oauth"]',
    })
    expect((await undo(edited.undo?.group ?? '')).status).toBe(200)
    expect(await appRow(id)).toMatchObject({
      name: 'Loom',
      max_scope: 'write',
      contact_email: 'new@loom.example',
      redirect_uris: '["http://127.0.0.1/callback"]',
    })
  })

  test('saving what it holds changes nothing; an undo after a later edit is refused', async () => {
    const id = await register()
    expect(
      (await act({ action: 'app.edit', ids: [id], args: { app: settings() } })).failed,
    ).toEqual([{ id, error: 'not_applicable' }])
    const first = await act({
      action: 'app.edit',
      ids: [id],
      args: { app: settings({ name: 'One' }) },
    })
    await act({ action: 'app.edit', ids: [id], args: { app: settings({ name: 'Two' }) } })
    expect((await undo(first.undo?.group ?? '')).status).toBe(409)
    expect((await appRow(id))?.name).toBe('Two')
    expect(
      (
        await act({
          action: 'app.edit',
          ids: [id],
          args: { app: settings({ maxScope: 'admin' as never }) },
        })
      ).failed,
    ).toEqual([{ id, error: 'invalid' }])
  })
})

describe('ending every connection', () => {
  test('ends each member’s grant and every device’s tokens, with no undo', async () => {
    const id = await register()
    await act({ action: 'app.approve', ids: [id] })
    const ann = await signedIn(api, 'ann@x.test')
    const bob = await signedIn(api, 'bob@x.test')
    await connect(id, ann.userId)
    await connect(id, bob.userId)
    const row = (await apps('approved')).rows[0]
    expect(row).toMatchObject({ connections: 2, lastUsedAt: expect.any(Number) })
    expect(row?.actions).toEqual(['app.edit', 'app.suspend', 'app.endConnections'])

    const ended = await act({ action: 'app.endConnections', ids: [id] })
    expect(ended).toEqual({ done: [id], failed: [], undo: null })
    const grants = await api.db.all<{ ended_at: number | null; end_reason: string | null }>(
      sql`select ended_at, end_reason from app_grants where app_id = ${Number(id)}`,
    )
    expect(grants).toHaveLength(2)
    for (const g of grants)
      expect(g).toEqual({ ended_at: expect.any(Number), end_reason: 'appEnded' })
    const tokens = await api.db.all<{ end_reason: string | null }>(sql`
      select t.end_reason from app_tokens t join app_grants g on g.id = t.grant_id
      where g.app_id = ${Number(id)}
    `)
    expect(tokens.map((t) => t.end_reason)).toEqual(['appEnded', 'appEnded'])
    // The app stands as it was, and has nothing left to end.
    expect((await appRow(id))?.status).toBe('approved')
    expect((await apps('approved')).rows[0]?.actions).toEqual(['app.edit', 'app.suspend'])
    expect((await act({ action: 'app.endConnections', ids: [id] })).failed).toEqual([
      { id, error: 'not_applicable' },
    ])
    const history = (await get<AdminAppDetail>(`apps/${id}`)).history
    expect(history[0]).toMatchObject({ action: 'app.endConnections', from: { connections: 2 } })
  })
})

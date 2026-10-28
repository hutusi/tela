/**
 * The console's Apps area (ADRs 0039, 0064, 0067): registering an app, approving it, cutting it
 * off and restoring it, editing what it may do, ending every connection to it, and reviewing the
 * apps members register; each audited, and every action but ending connections with an undo. An
 * audit row never holds the developer's address.
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
import { registerApp } from './apps-helpers'
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
    expect(list.counts).toEqual({ review: 0, approved: 0, draft: 1, suspended: 0 })
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
    // The operator's own registration is reviewed as it is made (ADR 0067), and no member's.
    expect(row).toMatchObject({
      registeredBy: null,
      termsAt: null,
      reviewedAt: api.clock.now(),
      reviewedBy: { id: ops.userId },
      reviewRequestedAt: null,
    })
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

describe('reviewing an app a member registered (ADR 0067)', () => {
  /** Mara's app, registered in Settings → Developer, live, and asking for a review. */
  async function marasApp(over: { wantsEmail?: boolean; note?: string | null } = {}) {
    const mara = await signedIn(api, 'mara@x.test')
    const app = await registerApp(api, {
      developerId: mara.userId,
      ownerUserId: mara.userId,
      reviewed: false,
    })
    const asked = api.clock.now()
    await api.db.run(sql`update apps set review_requested_at = ${asked},
        review_note = ${over.note === undefined ? 'A desktop reader.' : over.note},
        review_wants_email = ${over.wantsEmail ? 1 : 0}, terms_at = ${asked - 1000}
      where id = ${app.id}`)
    return { mara, id: String(app.id), asked }
  }

  const reviewOf = (id: string) =>
    first<{
      reviewed_at: number | null
      reviewed_by: string | null
      review_requested_at: number | null
      allow_email: number
    }>(
      api.db,
      sql`select reviewed_at, reviewed_by, review_requested_at, allow_email from apps
        where id = ${Number(id)}`,
    )

  test('the area opens on the queue, with who registered it and what they asked', async () => {
    const { mara, id, asked } = await marasApp({ wantsEmail: true })
    await register()
    const opened = await get<AdminList<AdminAppRow, 'apps'>>('apps')
    expect(opened.counts).toEqual({ review: 1, approved: 1, draft: 1, suspended: 0 })
    expect(opened.rows.map((r) => r.id)).toEqual([id])
    expect(opened.rows[0]).toMatchObject({
      status: 'approved',
      registeredBy: { id: mara.userId },
      owner: { id: mara.userId },
      termsAt: asked - 1000,
      reviewedAt: null,
      reviewedBy: null,
      reviewRequestedAt: asked,
      reviewNote: 'A desktop reader.',
      reviewWantsEmail: true,
      // The likeliest first: review it, or say there is nothing to review.
      actions: ['app.review', 'app.dismissReview', 'app.edit', 'app.suspend'],
    })
    // Searched within the queue too.
    const searched = await api.request('/api/v1/admin/apps', {
      as: ops,
      body: { f: 'review', q: 'Loom' },
    })
    expect(((await searched.json()) as AdminList<AdminAppRow, 'apps'>).rows).toEqual([])
  })

  test('a review lifts it, granting the email if the operator says so, with an undo', async () => {
    const { id, asked } = await marasApp({ wantsEmail: true })
    // Whether it may ask for the email is the operator's answer, and must be given.
    expect((await act({ action: 'app.review', ids: [id] })).failed).toEqual([
      { id, error: 'invalid' },
    ])
    expect(parseAct({ action: 'app.review', ids: [id], args: { allowEmail: 'yes' } })).toBeNull()

    const reviewed = await act({ action: 'app.review', ids: [id], args: { allowEmail: true } })
    expect(reviewed.done).toEqual([id])
    expect(await reviewOf(id)).toEqual({
      reviewed_at: api.clock.now(),
      reviewed_by: ops.userId,
      review_requested_at: null,
      allow_email: 1,
    })
    expect((await apps('review')).rows).toEqual([])
    const row = (await apps('approved')).rows.find((r) => r.id === id)
    expect(row).toMatchObject({ reviewedBy: { id: ops.userId }, allowEmail: true })
    expect(row?.actions).toEqual(['app.edit', 'app.suspend'])
    // Reviewed already: nothing to change.
    expect(
      (await act({ action: 'app.review', ids: [id], args: { allowEmail: false } })).failed,
    ).toEqual([{ id, error: 'not_applicable' }])

    expect((await undo(reviewed.undo?.group ?? '')).status).toBe(200)
    expect(await reviewOf(id)).toEqual({
      reviewed_at: null,
      reviewed_by: null,
      review_requested_at: asked,
      allow_email: 0,
    })
    expect((await apps('review')).rows.map((r) => r.id)).toEqual([id])
  })

  test('an edit since stands in the way of undoing a review: both write the email', async () => {
    const { id } = await marasApp()
    const reviewed = await act({ action: 'app.review', ids: [id], args: { allowEmail: false } })
    const row = (await get<AdminAppDetail>(`apps/${id}`)).app
    const edit = await act({
      action: 'app.edit',
      ids: [id],
      args: {
        app: settings({
          name: row.name,
          developer: row.developer,
          contactEmail: row.contactEmail,
          redirectUris: row.redirectUris,
          allowEmail: true,
          owner: row.owner?.handle ?? null,
        }),
      },
    })
    expect(edit.done).toEqual([id])
    expect((await undo(reviewed.undo?.group ?? '')).status).toBe(409)
    expect((await reviewOf(id))?.reviewed_at).toBe(api.clock.now())
  })

  test('a dismissal answers the request and leaves it unreviewed, with an undo', async () => {
    const { id, asked } = await marasApp()
    const dismissed = await act({ action: 'app.dismissReview', ids: [id] })
    expect(dismissed.done).toEqual([id])
    expect(await reviewOf(id)).toMatchObject({ reviewed_at: null, review_requested_at: null })
    expect((await apps('review')).rows).toEqual([])
    // Not reviewed, so the operator can still review it; nothing is left to dismiss.
    expect((await apps('approved')).rows.find((r) => r.id === id)?.actions).toEqual([
      'app.edit',
      'app.suspend',
      'app.review',
    ])
    expect((await act({ action: 'app.dismissReview', ids: [id] })).failed).toEqual([
      { id, error: 'not_applicable' },
    ])
    expect((await undo(dismissed.undo?.group ?? '')).status).toBe(200)
    expect((await reviewOf(id))?.review_requested_at).toBe(asked)

    // Reviewed after a dismissal, the dismissal can no longer be undone.
    const again = await act({ action: 'app.dismissReview', ids: [id] })
    await act({ action: 'app.review', ids: [id], args: { allowEmail: false } })
    expect((await undo(again.undo?.group ?? '')).status).toBe(409)
    const history = (await get<AdminAppDetail>(`apps/${id}`)).history.map((h) => h.action)
    expect(history.slice(0, 2)).toEqual(['app.review', 'app.dismissReview'])
  })

  test('a cut-off app is not reviewed, though its request can be dismissed', async () => {
    const { id } = await marasApp()
    await act({ action: 'app.suspend', ids: [id] })
    const listed = (await apps('review')).rows.find((r) => r.id === id)
    expect(listed?.actions).toEqual(['app.dismissReview', 'app.restore', 'app.edit'])
    expect(
      (await act({ action: 'app.review', ids: [id], args: { allowEmail: false } })).failed,
    ).toEqual([{ id, error: 'not_applicable' }])
  })

  test('its owner is its developer, whatever an edit names', async () => {
    const { mara, id } = await marasApp()
    await signedIn(api, 'ned@x.test')
    const ned = (
      await first<{ handle: string }>(
        api.db,
        sql`select p.handle from profiles p join user u on u.id = p.user_id
          where u.email = 'ned@x.test'`,
      )
    )?.handle
    const row = (await get<AdminAppDetail>(`apps/${id}`)).app
    const edited = await act({
      action: 'app.edit',
      ids: [id],
      args: {
        app: settings({
          name: 'Renamed',
          developer: row.developer,
          contactEmail: row.contactEmail,
          redirectUris: row.redirectUris,
          owner: ned ?? null,
        }),
      },
    })
    expect(edited.done).toEqual([id])
    expect(await appRow(id)).toMatchObject({ name: 'Renamed', owner_user_id: mara.userId })
    // Nor can it be taken away.
    const cleared = await act({
      action: 'app.edit',
      ids: [id],
      args: {
        app: settings({
          name: 'Renamed again',
          developer: row.developer,
          contactEmail: row.contactEmail,
          redirectUris: row.redirectUris,
          owner: null,
        }),
      },
    })
    expect(cleared.done).toEqual([id])
    expect((await appRow(id))?.owner_user_id).toBe(mara.userId)
  })
})

describe('the contacts of live apps (ADR 0067)', () => {
  const contacts = (token = ADMIN_TOKEN) =>
    api.request('/api/admin/apps/contacts', {
      method: 'GET',
      headers: { authorization: `Bearer ${token}` },
    })

  test('lists every live app’s name and address, for the operator’s token alone', async () => {
    const live = await register({ name: 'Weft', contactEmail: 'hi@weft.example' })
    await act({ action: 'app.approve', ids: [live] })
    await register({ name: 'Draft only', contactEmail: 'draft@x.example' })
    const cut = await register({ name: 'Cut', contactEmail: 'cut@x.example' })
    await act({ action: 'app.approve', ids: [cut] })
    await act({ action: 'app.suspend', ids: [cut] })
    // A live app of a suspended developer is cut off too, so it is no one to write to.
    const mara = await signedIn(api, 'mara@x.test')
    await api.db.run(sql`insert into apps (client_id, name, developer, contact_email, status,
        developer_id, owner_user_id, created_at, updated_at)
      values ('tela_app_suspended01', 'Barred', 'Mara', 'mara@x.example', 'approved',
        ${mara.userId}, ${mara.userId}, 0, 0)`)
    await api.db.run(sql`update profiles set suspended_at = 1 where user_id = ${mara.userId}`)

    const res = await contacts()
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    const body = (await res.json()) as {
      apps: { clientId: string; name: string; contactEmail: string }[]
    }
    expect(body.apps).toEqual([
      {
        clientId: expect.stringMatching(/^tela_app_/),
        name: 'Weft',
        contactEmail: 'hi@weft.example',
      },
    ])
    expect((await contacts('wrong')).status).toBe(403)
    // Never through the console's cookie: an admin's session is not the operator's token.
    expect((await api.request('/api/admin/apps/contacts', { method: 'GET', as: ops })).status).toBe(
      403,
    )
  })
})

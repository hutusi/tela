/**
 * The admin console's door and write path (ADR 0039): who gets in, what a write leaves in the
 * audit log, and an undo that restores only what nobody has changed since.
 */
import { beforeEach, describe, expect, test } from 'bun:test'
import { first } from '@tela/data'
import { CLIENT_HEADER, MEMBER_HEADER } from '@tela/sync'
import { sql } from 'drizzle-orm'
import { parseAct } from '../src/routes/admin'
import { ADMIN_TOKEN, createTestApi, type SignedIn, signedIn, type TestApi } from './helpers'

let api: TestApi

beforeEach(async () => {
  api = await createTestApi()
})

const grant = (email: string, admin = true, token = ADMIN_TOKEN) =>
  api.request('/api/admin/admins', {
    body: { email, admin },
    headers: { authorization: `Bearer ${token}` },
  })

async function admin(email = 'ops@x.test'): Promise<SignedIn> {
  const who = await signedIn(api, email)
  expect((await grant(email)).status).toBe(200)
  return who
}

async function addSite(listing = 'private', claimedBy: string | null = null): Promise<number> {
  const now = api.clock.now()
  const [row] = await api.db.all<{ id: number }>(sql`
    insert into sites (home_url, listing, claimed_by, created_at, updated_at)
    values (${`https://${Math.random().toString(36).slice(2)}.test`}, ${listing}, ${claimedBy},
      ${now}, ${now})
    returning id
  `)
  return row?.id ?? 0
}

const listingOf = async (id: number) =>
  (await first<{ listing: string }>(api.db, sql`select listing from sites where id = ${id}`))
    ?.listing

const act = (as: SignedIn, body: unknown) => api.request('/api/v1/admin/act', { as, body })

describe('the door', () => {
  test('is a 401 signed out and a 403 for a member who is not an admin', async () => {
    expect((await api.request('/api/v1/admin/act', { body: {} })).status).toBe(401)
    const member = await signedIn(api)
    const refused = await act(member, { action: 'site.feature', ids: ['1'] })
    expect(refused.status).toBe(403)
    expect(refused.headers.get('cache-control')).toBe('no-store')
  })

  test('asks an old client to upgrade and a client naming someone else to start over', async () => {
    const ops = await admin()
    const old = await api.request('/api/v1/admin/act', {
      as: { ...ops, headers: { ...ops.headers, [CLIENT_HEADER]: '1' } },
      body: {},
    })
    expect(old.status).toBe(409)
    expect(await old.json()).toEqual({ error: 'upgrade' })
    const other = await api.request('/api/v1/admin/act', {
      as: { ...ops, headers: { ...ops.headers, [MEMBER_HEADER]: 'someone-else' } },
      body: {},
    })
    expect(await other.json()).toEqual({ error: 'account_changed' })
  })

  test('opens on grant and closes on ungrant at once, past the cookie cache', async () => {
    const ops = await admin()
    const site = await addSite()
    expect((await act(ops, { action: 'site.feature', ids: [String(site)] })).status).toBe(200)
    expect((await grant('ops@x.test', false)).status).toBe(200)
    expect((await act(ops, { action: 'site.hide', ids: [String(site)] })).status).toBe(403)
    expect(await listingOf(site)).toBe('featured')
  })
})

describe('granting', () => {
  test('needs the operator token, and an account', async () => {
    await signedIn(api, 'a@x.test')
    expect((await grant('a@x.test', true, 'wrong')).status).toBe(403)
    expect((await grant('nobody@x.test')).status).toBe(404)
    expect((await grant('a@x.test', 'yes' as unknown as boolean)).status).toBe(400)
  })

  test('says whether it changed anything, and audits only a change', async () => {
    await signedIn(api, 'a@x.test')
    expect(await (await grant('A@x.test')).json()).toMatchObject({ admin: true, changed: true })
    expect(await (await grant('a@x.test')).json()).toMatchObject({ admin: true, changed: false })
    const rows = await api.db.all<{ action: string; actor_id: string | null; detail: string }>(
      sql`select action, actor_id, detail from admin_actions`,
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ action: 'admin.grant', actor_id: null })
    expect(JSON.parse(rows[0]?.detail ?? '{}')).toEqual({
      from: { isAdmin: 0 },
      to: { isAdmin: true },
    })
  })

  test("reaches the member's devices through the pull", async () => {
    const ops = await admin()
    const pull = await api.request('/api/v1/sync?cursor=0', { as: ops })
    const body = (await pull.json()) as { rows: { profile: { isAdmin?: boolean }[] } }
    expect(body.rows.profile[0]?.isAdmin).toBe(true)
  })
})

describe('acting', () => {
  test('refuses a request it cannot read', async () => {
    const ops = await admin()
    for (const body of [
      {},
      { action: 'site.explode', ids: ['1'] },
      { action: 'site.feature', ids: [1] },
      { action: 'site.feature', ids: ['1', '1'] },
      { action: 'site.feature', ids: [] },
      { action: 'site.feature', ids: Array.from({ length: 51 }, (_, i) => String(i + 1)) },
    ]) {
      expect((await act(ops, body)).status).toBe(400)
    }
  })

  test('parses arguments strictly', () => {
    expect(
      parseAct({ action: 'claim.reject', ids: ['1'], args: { reason: 'x'.repeat(301) } }),
    ).toBe(null)
    expect(parseAct({ action: 'code.addUses', ids: ['A'], args: { uses: 1.5 } })).toBe(null)
    expect(parseAct({ action: 'site.topics', ids: ['1'], args: { topics: ['tech'] } })).toEqual({
      action: 'site.topics',
      ids: ['1'],
      args: { topics: ['tech'] },
    })
  })

  test('changes each target, says which did not apply, and logs one group', async () => {
    const ops = await admin()
    const a = await addSite('listed')
    const b = await addSite('featured')
    const res = await act(ops, { action: 'site.feature', ids: [String(a), String(b), '999'] })
    const body = (await res.json()) as {
      done: string[]
      failed: { id: string; error: string }[]
      undo: { group: string } | null
    }
    expect(body.done).toEqual([String(a)])
    expect(body.failed).toEqual([
      { id: String(b), error: 'not_applicable' },
      { id: '999', error: 'not_found' },
    ])
    expect(body.undo).not.toBeNull()
    const rows = await api.db.all<{ group_id: string; actor_id: string; target_key: string }>(
      sql`select group_id, actor_id, target_key from admin_actions where action = 'site.feature'`,
    )
    expect(rows).toEqual([
      { group_id: body.undo?.group ?? '', actor_id: ops.userId, target_key: String(a) },
    ])
  })

  test('restores what the doors say: listed once claimed, private otherwise', async () => {
    const ops = await admin()
    const claimed = await addSite('featured', ops.userId)
    const lone = await addSite('rejected')
    await act(ops, { action: 'site.restore', ids: [String(claimed), String(lone)] })
    expect(await listingOf(claimed)).toBe('listed')
    expect(await listingOf(lone)).toBe('private')
  })
})

describe('undo', () => {
  test('restores every target of the group, once', async () => {
    const ops = await admin()
    const a = await addSite('listed')
    const b = await addSite('private')
    const { undo } = (await (
      await act(ops, { action: 'site.hide', ids: [String(a), String(b)] })
    ).json()) as { undo: { group: string } }
    const res = await api.request('/api/v1/admin/undo', { as: ops, body: undo })
    expect(await res.json()).toEqual({ restored: 2 })
    expect(await listingOf(a)).toBe('listed')
    expect(await listingOf(b)).toBe('private')
    const again = await api.request('/api/v1/admin/undo', { as: ops, body: undo })
    expect(again.status).toBe(409)
    const undone = await api.db.all<{ action: string; detail: string }>(
      sql`select action, detail from admin_actions where action = 'undo'`,
    )
    expect(undone).toHaveLength(2)
    expect(JSON.parse(undone[0]?.detail ?? '{}')).toMatchObject({
      group: undo.group,
      undid: 'site.hide',
      from: { listing: 'rejected' },
    })
  })

  test('restores nothing when a target moved on since', async () => {
    const ops = await admin()
    const a = await addSite('listed')
    const b = await addSite('listed')
    const { undo } = (await (
      await act(ops, { action: 'site.feature', ids: [String(a), String(b)] })
    ).json()) as { undo: { group: string } }
    await act(ops, { action: 'site.hide', ids: [String(b)] })
    const res = await api.request('/api/v1/admin/undo', { as: ops, body: undo })
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'changed_since' })
    expect(await listingOf(a)).toBe('featured')
    expect(await listingOf(b)).toBe('rejected')
  })

  test('restores nothing once a later action touched the target, even one that came back', async () => {
    const ops = await admin()
    const a = await addSite('listed')
    const groupOf = async (action: string) =>
      ((await (await act(ops, { action, ids: [String(a)] })).json()) as { undo: { group: string } })
        .undo.group
    const featured = await groupOf('site.feature')
    await groupOf('site.hide')
    await groupOf('site.feature')
    // Featured again, as the first action left it; undoing that one would take back 'listed',
    // a value two later choices have overruled.
    const res = await api.request('/api/v1/admin/undo', { as: ops, body: { group: featured } })
    expect(res.status).toBe(409)
    expect(await listingOf(a)).toBe('featured')
  })

  test('is a 404 for a group it does not know', async () => {
    const ops = await admin()
    const res = await api.request('/api/v1/admin/undo', { as: ops, body: { group: 'nope' } })
    expect(res.status).toBe(404)
  })
})

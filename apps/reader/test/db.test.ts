/**
 * The device database itself, on an in-memory IndexedDB: what two tabs and an earlier build do
 * to it. Two connections to one database name are two tabs.
 */
import 'fake-indexeddb/auto'
import { describe, expect, test } from 'bun:test'
import {
  applyPull,
  emptyTables,
  type Pending,
  type PullResponse,
  rowsOf,
  type TableRows,
} from '@tela/sync'
import { openDB } from 'idb'
import { indexedDbPersistence } from '../src/store/db'
import { metaKeys, seedEarlierBuild } from './earlier-build'
import { profile, pull, sub } from './rows'

const change = (mid: string, at: number, articleId: number) =>
  ({ mutation: { mid, at, type: 'markRead', articleId } }) as Pending
const mids = (pending: Pending[]) => pending.map((p) => p.mutation.mid)
const fresh = () => `tela-test-${crypto.randomUUID()}`
/** Every table, as a snapshot leaves them. */
const tablesOf = (p: PullResponse): TableRows =>
  rowsOf(applyPull({ cursor: 0, tables: emptyTables() }, p).tables)

describe('the device database', () => {
  test('each unsent change is a record of its own, so two tabs never erase each other', async () => {
    const name = fresh()
    const one = await indexedDbPersistence(name)
    const two = await indexedDbPersistence(name)
    await one.claim('a')
    expect(await one.commit('a', { put: [change('mid-one-0001', 1, 7)] })).toBe(true)
    expect(await two.commit('a', { put: [change('mid-two-0001', 2, 8)] })).toBe(true)
    expect(mids((await one.load()).pending)).toEqual(['mid-one-0001', 'mid-two-0001'])
    await two.commit('a', { drop: ['mid-two-0001'] })
    expect(mids((await one.load()).pending)).toEqual(['mid-one-0001'])
  })

  test('a write for an owner the copy no longer has writes nothing', async () => {
    const name = fresh()
    const one = await indexedDbPersistence(name)
    const two = await indexedDbPersistence(name)
    const alice = tablesOf(
      pull(5, { profile: [{ ...profile, handle: 'alice' }], subscriptions: [sub(1)] }, true),
    )
    const bob = tablesOf(
      pull(6, { profile: [{ ...profile, handle: 'bob' }], subscriptions: [sub(2)] }, true),
    )
    expect(await one.claim('a')).toBe(true)
    await one.commit('a', { tables: alice, cursor: 5 })

    // The other tab signs in as b: its claim wipes a's copy, and it writes b's.
    expect(await two.claim('b')).toBe(true)
    expect(await two.commit('b', { tables: bob, cursor: 6 })).toBe(true)

    // The first tab still holds a, and writes as a: a change, a's tables, a's cursor.
    const refused = await one.commit('a', {
      put: [change('mid-a-0001', 1, 7)],
      tables: alice,
      cursor: 9,
    })
    expect(refused).toBe(false)
    const stored = await two.load()
    expect(stored.owner).toBe('b')
    expect(stored.cursor).toBe(6)
    expect(stored.rows?.profile?.handle).toBe('bob')
    expect(stored.rows?.subscriptions.map((s) => s.feedId)).toEqual([2])
    expect(stored.pending).toEqual([])
  })

  test('a copy an earlier build wrote starts over', async () => {
    const name = fresh()
    await seedEarlierBuild(name, pull(5, { profile: [profile], subscriptions: [sub(1)] }, true), {
      userId: 'a',
      legacy: [change('mid-old-0002', 2, 8)],
      keyed: [change('mid-old-0001', 1, 7)],
    })
    const now = await indexedDbPersistence(name)
    const loaded = await now.load()
    expect(loaded).toEqual({ owner: null, cursor: 0, rows: null, pending: [] })
    // Nothing of it is left to be read back later, under anyone.
    expect(await metaKeys(name)).toEqual([])
    expect(await now.bodyKeys()).toEqual([])
  })

  test('claiming a copy nobody owns wipes it, and so does claiming an earlier build’s for its own member', async () => {
    const name = fresh()
    await seedEarlierBuild(name, pull(5, { profile: [profile] }, true), { userId: 'a' })
    const one = await indexedDbPersistence(name)
    expect(await one.claim('a')).toBe(true)
    expect(await one.load()).toEqual({ owner: 'a', cursor: 0, rows: null, pending: [] })
    expect(await metaKeys(name)).toEqual(['owner'])
    // Claiming it again as the same member keeps it.
    await one.commit('a', { cursor: 3 })
    expect(await one.claim('a')).toBe(false)
    expect(await metaKeys(name)).toEqual(['cursor', 'owner'])
  })

  test('a pending record tagged with another owner, or with none, is dropped on load', async () => {
    const name = fresh()
    const one = await indexedDbPersistence(name)
    await one.claim('a')
    await one.commit('a', { put: [change('mid-a-0001', 1, 7)] })
    // Records only a build that did not check could have left: another owner's, and untagged.
    const raw = await openDB(name, 1)
    await raw.put('meta', { ...change('mid-b-0001', 2, 8), owner: 'b' }, 'pending:mid-b-0001')
    await raw.put('meta', change('mid-x-0001', 3, 9), 'pending:mid-x-0001')
    raw.close()
    expect(mids((await one.load()).pending)).toEqual(['mid-a-0001'])
    expect(await metaKeys(name)).toEqual(['owner', 'pending:mid-a-0001'])
  })

  test("release keeps another owner's copy, and wipes its own", async () => {
    const name = fresh()
    const one = await indexedDbPersistence(name)
    const two = await indexedDbPersistence(name)
    await one.claim('a')
    await two.claim('b')
    const bob = tablesOf(pull(6, { profile: [{ ...profile, handle: 'bob' }] }, true))
    await two.commit('b', { tables: bob, cursor: 6 })
    expect(await one.release('a')).toBe(false)
    const kept = await two.load()
    expect(kept.owner).toBe('b')
    expect(kept.rows?.profile?.handle).toBe('bob')

    expect(await two.release('b')).toBe(true)
    expect(await metaKeys(name)).toEqual([])
    expect((await two.load()).rows).toBeNull()
    // Nobody's now: nothing writes into it until someone claims it.
    expect(await two.commit('b', { cursor: 7 })).toBe(false)
    expect(await metaKeys(name)).toEqual([])
  })

  test('a release and a claim started together never leave rows without an owner', async () => {
    for (let i = 0; i < 20; i++) {
      const name = fresh()
      const one = await indexedDbPersistence(name)
      const two = await indexedDbPersistence(name)
      await one.claim('a')
      await one.commit('a', { cursor: 5 })
      await Promise.all(
        i % 2 ? [one.release('a'), two.claim('b')] : [two.claim('b'), one.release('a')],
      )
      expect(await two.commit('b', { cursor: 6 })).toBe(true)
      expect(await metaKeys(name)).toEqual(['cursor', 'owner'])
      expect((await two.load()).owner).toBe('b')
    }
  })
})

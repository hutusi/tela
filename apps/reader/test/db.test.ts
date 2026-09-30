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
import {
  DATABASE,
  earlierBuild,
  indexedDbPersistence,
  memoryPersistence,
  type Persistence,
} from '../src/store/db'
import { LocalStore } from '../src/store/local'
import { metaKeys, seedEarlierBuild } from './earlier-build'
import { NOW, profile, pull, sub } from './rows'

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

  test('a copy written before a table existed starts over from a snapshot (follows, ADR 0031)', async () => {
    const name = fresh()
    const one = await indexedDbPersistence(name)
    await one.claim('a')
    const tables = tablesOf(pull(5, { profile: [profile], subscriptions: [sub(1)] }, true))
    expect(await one.commit('a', { tables, cursor: 5 })).toBe(true)
    // What the build before follows left: every other table, and a cursor past rows it dropped.
    const raw = await openDB(name)
    await raw.delete('tables', 'follows')
    raw.close()
    const loaded = await one.load()
    expect(loaded.owner).toBe('a')
    expect(loaded.cursor).toBe(0)
    expect(loaded.rows).toBeNull()
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
    expect(loaded).toEqual({ owner: null, unverified: null, cursor: 0, rows: null, pending: [] })
    // Nothing of it is left to be read back later, under anyone.
    expect(await metaKeys(name)).toEqual([])
    expect(await now.bodyKeys()).toEqual([])
  })

  test('claiming a copy nobody owns wipes it, and so does claiming an earlier build’s for its own member', async () => {
    const name = fresh()
    await seedEarlierBuild(name, pull(5, { profile: [profile] }, true), { userId: 'a' })
    const one = await indexedDbPersistence(name)
    expect(await one.claim('a')).toBe(true)
    expect(await one.load()).toEqual({
      owner: 'a',
      unverified: null,
      cursor: 0,
      rows: null,
      pending: [],
    })
    expect(await metaKeys(name)).toEqual(['owner'])
    // Claiming it again as the same member keeps it.
    await one.commit('a', { from: 0, cursor: 3 })
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
      await one.commit('a', { from: 0, cursor: 5 })
      await Promise.all(
        i % 2 ? [one.release('a'), two.claim('b')] : [two.claim('b'), one.release('a')],
      )
      expect(await two.commit('b', { from: 0, cursor: 6 })).toBe(true)
      expect(await metaKeys(name)).toEqual(['cursor', 'owner'])
      expect((await two.load()).owner).toBe('b')
    }
  })

  test("a commit and a claim started together never leave the old owner's rows under the new", async () => {
    // Only one transaction for the owner check and the write makes this hold: checked in one and
    // written in another, the claim lands between them and a's rows are stored under b.
    const alice = tablesOf(
      pull(5, { profile: [{ ...profile, handle: 'alice' }], subscriptions: [sub(1)] }, true),
    )
    for (let i = 0; i < 30; i++) {
      const name = fresh()
      const one = await indexedDbPersistence(name)
      const two = await indexedDbPersistence(name)
      await one.claim('a')
      const write = () =>
        one.commit('a', { tables: alice, cursor: 9, put: [change(`m-${i}-0001`, 1, 7)] })
      await Promise.all(i % 2 ? [write(), two.claim('b')] : [two.claim('b'), write()])
      expect(await two.load()).toEqual({
        owner: 'b',
        unverified: null,
        cursor: 0,
        rows: null,
        pending: [],
      })
      expect(await metaKeys(name)).toEqual(['owner'])
    }
  })

  test('the stored cursor only moves forward, unless a snapshot rewrites every table', async () => {
    const name = fresh()
    const one = await indexedDbPersistence(name)
    const two = await indexedDbPersistence(name)
    await one.claim('a')
    const at = (n: number, feed: number) =>
      tablesOf(pull(n, { profile: [profile], subscriptions: [sub(feed)] }, true))
    await one.commit('a', { tables: at(5, 1), cursor: 5 })
    // One tab of a stores newer subscriptions at cursor 10.
    await one.commit('a', {
      tables: { subscriptions: at(10, 2).subscriptions },
      from: 5,
      cursor: 10,
    })
    // Another tab of a, behind, writes older subscriptions at cursor 8, and a change of its own.
    const behind = await two.commit('a', {
      tables: { subscriptions: at(8, 3).subscriptions },
      from: 5,
      cursor: 8,
      put: [change('mid-two-0001', 1, 7)],
    })
    expect(behind).toBe(true)
    const kept = await one.load()
    expect(kept.cursor).toBe(10)
    expect(kept.rows?.subscriptions.map((x) => x.feedId)).toEqual([2])
    expect(mids(kept.pending)).toEqual(['mid-two-0001'])
    // A snapshot (every table) may lower it: a restore from a backup answers one.
    await two.commit('a', { tables: at(4, 4), cursor: 4 })
    const restored = await one.load()
    expect(restored.cursor).toBe(4)
    expect(restored.rows?.subscriptions.map((x) => x.feedId)).toEqual([4])
  })

  test('this build keeps its own database, and sees when an earlier build has written its own', async () => {
    // An earlier build's tab left open writes 'tela' without checking anyone; this build's copy
    // is elsewhere, so nothing it writes can land in this build's.
    expect(DATABASE).not.toBe('tela')
    const seed = () =>
      seedEarlierBuild('tela', pull(5, { profile: [profile], subscriptions: [sub(1)] }, true), {
        userId: 'a',
      })
    await seed()
    const now = await indexedDbPersistence()
    expect(await now.load()).toEqual({
      owner: null,
      unverified: null,
      cursor: 0,
      rows: null,
      pending: [],
    })
    await now.claim('b')

    // It ran: its sign-out or sign-in never reached this copy. Looking changes nothing.
    expect(await earlierBuild.wrote()).toBe(true)
    expect(await earlierBuild.wrote()).toBe(true)
    // Its copy is emptied, not deleted (a deletion would wait on its open tabs, and hang one of
    // them reloading), and marked where that build never reads: its sign-out takes the mark.
    const emptied = await earlierBuild.empty()
    expect(emptied).not.toBeNull()
    expect(await metaKeys('tela')).toEqual(['tela-2:seen'])
    expect((await indexedDB.databases()).map((d) => d.name)).toContain('tela')
    // Being emptied still reads as touched, until the tab that emptied it says it is seen: a tab
    // that looks meanwhile, or after that tab died, marks its own copy first.
    expect(await earlierBuild.wrote()).toBe(true)
    await earlierBuild.seen('another tab’s')
    expect(await earlierBuild.wrote()).toBe(true)
    await earlierBuild.seen(emptied as string)
    // Nothing new since: nothing to distrust. And this build's own copy is untouched.
    expect(await earlierBuild.wrote()).toBe(false)
    expect(await earlierBuild.empty()).toBeNull()
    expect((await now.load()).owner).toBe('b')
    // Written again between the emptying and the seen mark: it stays touched.
    await seed()
    const again = await earlierBuild.empty()
    await seed()
    await earlierBuild.seen(again as string)
    expect(await earlierBuild.wrote()).toBe(true)
    // It runs again, and is seen again.
    await seed()
    expect(await earlierBuild.wrote()).toBe(true)
  })

  test('a pull that starts past the stored cursor does not land, so no rows go missing between', async () => {
    // Found in review: a tab behind sets the copy back with its snapshot, then a tab ahead
    // writes a newer delta; the copy would claim a cursor past rows it never stored.
    const name = fresh()
    const ahead = await indexedDbPersistence(name)
    const behind = await indexedDbPersistence(name)
    await ahead.claim('a')
    const snap = (n: number, feeds: number[]) =>
      tablesOf(pull(n, { profile: [profile], subscriptions: feeds.map((f) => sub(f)) }, true))
    await ahead.commit('a', { tables: snap(100, [1]), cursor: 100 })
    // The tab ahead pulls 100..101: a second subscription.
    await ahead.commit('a', {
      tables: { subscriptions: snap(101, [1, 2]).subscriptions },
      from: 100,
      cursor: 101,
    })
    // The tab behind lands its slower snapshot at 100, which sets the copy back.
    await behind.commit('a', { tables: snap(100, [1]), cursor: 100 })
    // The tab ahead pulls 101..102 and touches only articles: it cannot show it covers 100..101.
    await ahead.commit('a', { tables: { articles: [] }, from: 101, cursor: 102 })
    const stored = await behind.load()
    expect(stored.cursor).toBe(100)
    expect(stored.rows?.subscriptions.map((x) => x.feedId)).toEqual([1])
    // Consistent at 100: the next pull from there brings the second subscription back.
  })

  test('a tab ahead of a copy another tab set back writes its whole copy, and keeps it current', async () => {
    const name = fresh()
    const ahead = await indexedDbPersistence(name)
    const behind = await indexedDbPersistence(name)
    await ahead.claim('a')
    const snap = (n: number, feeds: number[]) =>
      tablesOf(pull(n, { profile: [profile], subscriptions: feeds.map((f) => sub(f)) }, true))
    await ahead.commit('a', { tables: snap(100, [1]), cursor: 100 })
    await ahead.commit('a', {
      tables: { subscriptions: snap(101, [1, 2]).subscriptions },
      from: 100,
      cursor: 101,
    })
    await behind.commit('a', { tables: snap(100, [1]), cursor: 100 })
    // The tab ahead pulls 101..102; its delta cannot land on the copy at 100, its whole copy can.
    const landed = await ahead.commit('a', {
      tables: { articles: [] },
      whole: snap(102, [1, 2]),
      from: 101,
      cursor: 102,
    })
    expect(landed).toBe(true)
    const stored = await behind.load()
    expect(stored.cursor).toBe(102)
    expect(stored.rows?.subscriptions.map((x) => x.feedId)).toEqual([1, 2])
    // A tab behind the copy still writes nothing over it, whole or not.
    await behind.commit('a', {
      tables: { articles: [] },
      whole: snap(90, [7]),
      from: 80,
      cursor: 90,
    })
    expect((await ahead.load()).cursor).toBe(102)
  })

  test('a tab ahead of the copy passes its whole copy with each pull, so the copy catches up', async () => {
    const name = fresh()
    const tab = async () => {
      const store = new LocalStore(await indexedDbPersistence(name), () => NOW)
      await store.open()
      return store
    }
    const ahead = await tab()
    await ahead.setUser('a')
    await ahead.applyPull(
      pull(100, { profile: [profile], subscriptions: [sub(1)] }, true),
      ahead.epoch,
    )
    await ahead.applyPull(pull(101, { subscriptions: [sub(2)] }), ahead.epoch)
    // Another tab of a lands its slower snapshot at 100, which sets the copy back.
    const behind = await tab()
    await behind.applyPull(
      pull(100, { profile: [profile], subscriptions: [sub(1)] }, true),
      behind.epoch,
    )
    // The tab ahead pulls 101..102, which touches nothing: its whole copy lands instead.
    await ahead.applyPull(pull(102, {}), ahead.epoch)
    const stored = await (await indexedDbPersistence(name)).load()
    expect(stored.cursor).toBe(102)
    expect(stored.rows?.subscriptions.map((x) => x.feedId)).toEqual([1, 2])
  })
})

describe('the mark an earlier build having run leaves', () => {
  const kinds: [string, () => Promise<[Persistence, Persistence]>][] = [
    [
      'IndexedDB',
      async () => {
        const name = fresh()
        return [await indexedDbPersistence(name), await indexedDbPersistence(name)]
      },
    ],
    [
      'memory',
      async () => {
        const one = memoryPersistence()
        return [one, one]
      },
    ],
  ]
  for (const [kind, tabs] of kinds) {
    test(`is cleared only by a claim from a tab that loaded it, and outlives a wipe (${kind})`, async () => {
      const [one, two] = await tabs()
      await one.claim('a')
      await one.distrust()
      const loaded = (await one.load()).unverified
      expect(loaded).not.toBeNull()
      // Another tab marks the copy again after this one loaded it: this tab's /me may have
      // answered before whatever that mark is about, so its claim leaves the newer one.
      await two.distrust()
      expect(await one.claim('a', loaded)).toBe(false)
      const newer = (await one.load()).unverified
      expect(newer).not.toBeNull()
      expect(newer).not.toBe(loaded)
      // A claim that loaded no mark clears none.
      await one.claim('a')
      expect((await one.load()).unverified).toBe(newer)
      // Wiped, by a release or by someone else's claim, the next copy is no better known.
      expect(await one.release('a')).toBe(true)
      expect(await one.load()).toEqual({
        owner: null,
        unverified: newer,
        cursor: 0,
        rows: null,
        pending: [],
      })
      expect(await one.claim('b', loaded)).toBe(true)
      expect((await one.load()).unverified).toBe(newer)
      // The claim of a tab that loaded it clears it.
      expect(await one.claim('b', newer)).toBe(false)
      expect((await one.load()).unverified).toBeNull()
    })
  }
})

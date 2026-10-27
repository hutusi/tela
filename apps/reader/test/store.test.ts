import 'fake-indexeddb/auto'
import { describe, expect, test } from 'bun:test'
import { applyPull, emptyTables, rowsOf } from '@tela/sync'
import {
  type Change,
  indexedDbPersistence,
  memoryPersistence,
  type Persistence,
  TABLES,
} from '../src/store/db'
import { LocalStore, type Stamp, type Timers } from '../src/store/local'
import { seedEarlierBuild } from './earlier-build'
import { article, inLang, NOW, profile, pull, sub, title } from './rows'

/** Memory storage that records which tables each write wrote. */
function recording(): Persistence & { saved: string[][] } {
  const inner = memoryPersistence()
  const saved: string[][] = []
  return {
    ...inner,
    saved,
    commit: async (owner, change) => {
      if (change.tables) saved.push(Object.keys(change.tables).sort())
      return inner.commit(owner, change)
    },
  }
}

const snapshot = pull(
  5,
  { profile: [profile], subscriptions: [sub(1)], articles: [article(7), article(8)] },
  true,
)

/** A store holding account `a`, synced to `snapshot`. */
async function member(storage: Persistence = memoryPersistence(), now = NOW, timers?: Timers) {
  const store = new LocalStore(storage, () => now, timers)
  await store.open()
  await store.setUser('a')
  await store.applyPull(snapshot, store.epoch)
  return store
}

describe('the device store', () => {
  test('shows a change the moment it is made, and queues it for the server', async () => {
    const store = await member()
    let pushes = 0
    store.onMutation = () => pushes++
    const before = store.getSnapshot()
    store.mutate({ type: 'setLiked', articleId: 7, liked: true })
    expect(store.getSnapshot()).not.toBe(before)
    expect(store.getSnapshot().tables.states.get(7)?.likedAt).toBe(NOW)
    expect(store.unsent()).toMatchObject([{ type: 'setLiked', articleId: 7, liked: true, at: NOW }])
    expect(pushes).toBe(1)
  })

  test('whom the server knows the member follows moves with the pull, not the prediction', async () => {
    const store = await member()
    const ID = 'member-anna-0000001'
    store.mutate({ type: 'follow', userId: ID })
    expect(store.getSnapshot().tables.follows.has(ID)).toBe(true) // shown at once
    expect(store.confirmedFollowees()).toBe('') // but the server has not heard of it
    await store.applyPull(
      pull(9, {
        follows: [
          {
            userId: ID,
            handle: 'anna',
            displayName: null,
            avatar: null,
            createdAt: NOW,
            deletedAt: null,
            seq: 9,
          },
        ],
      }),
      store.epoch,
    )
    expect(store.confirmedFollowees()).toBe(ID)
  })

  test('says when a pull changes whom the member follows, with the rows', async () => {
    const store = await member()
    const heard: string[][] = []
    store.onFollowsConfirmed = (rows) => heard.push(rows.map((r) => `${r.handle}:${r.deletedAt}`))
    const row = (deletedAt: number | null, seq: number) => ({
      userId: 'member-anna-0000001',
      handle: 'anna',
      displayName: null,
      avatar: null,
      createdAt: NOW,
      deletedAt,
      seq,
    })
    await store.applyPull(pull(9, { follows: [row(null, 9)] }), store.epoch)
    await store.applyPull(pull(10, { articles: [article(10)] }), store.epoch) // nothing to say
    await store.applyPull(pull(11, { follows: [row(11, 11)] }), store.epoch)
    // The unfollow comes with the row as it was, which still names whose page to forget.
    expect(heard).toEqual([['anna:null'], ['anna:null']])
  })

  test('a delta from a tela-api without follows lands, cursor and all', async () => {
    const storage = memoryPersistence()
    const store = await member(storage)
    const { follows: _f, ...rows } = pull(9, { articles: [article(9)] }).rows
    await store.applyPull(
      { cursor: 9, more: false, reset: false, rows, tombstones: [] } as unknown as Parameters<
        LocalStore['applyPull']
      >[0],
      store.epoch,
    )
    expect(store.getSnapshot().tables.articles.has(9)).toBe(true)
    expect((await storage.load()).cursor).toBe(9)
  })

  test('a copy taken from a tela-api before folders starts over when they come back (ADR 0048)', async () => {
    const storage = memoryPersistence()
    const store = await member(storage)
    const told: string[] = []
    store.onRestart = (why) => told.push(why)
    // A snapshot during a rollback of tela-api: no folder tables at all.
    const {
      folders: _f,
      feedFolders: _ff,
      ...old
    } = pull(9, { subscriptions: [sub(1)] }, true).rows
    const shape = (p: object) => p as unknown as Parameters<LocalStore['applyPull']>[0]
    expect(
      await store.applyPull(
        shape({ cursor: 9, more: false, reset: true, rows: old, tombstones: [] }),
        store.epoch,
      ),
    ).toBe(false)
    expect((await storage.load()).covered).not.toContain('folders')
    // A delta from the older tela-api changes nothing about that.
    expect(
      await store.applyPull(
        shape({ cursor: 10, more: false, reset: false, rows: old, tombstones: [] }),
        store.epoch,
      ),
    ).toBe(false)
    expect(store.cursor).toBe(10)
    // tela-api is back. Its delta starts past the folder made meanwhile: it is not folded in, and
    // the device asks for a snapshot, keeping what it shows until then.
    const folder = { id: 'folder-back', name: 'Back', createdAt: 1, updatedAt: 1, deletedAt: null }
    expect(await store.applyPull(pull(12, { articles: [article(12)] }), store.epoch)).toBe(true)
    expect(store.cursor).toBe(0)
    expect(store.getSnapshot().tables.subscriptions.has(1)).toBe(true)
    expect(store.getSnapshot().tables.articles.has(12)).toBe(false)
    expect(
      await store.applyPull(
        pull(12, { subscriptions: [sub(1)], folders: [{ ...folder, seq: 11 }] }, true),
        store.epoch,
      ),
    ).toBe(false)
    expect(store.getSnapshot().tables.folders.get('folder-back')?.name).toBe('Back')
    expect((await storage.load()).covered).toContain('folders')
    // Each start-over said why, down to the answer that left the tables out; the snapshot that
    // ended it did not, since it started from nothing.
    expect(told).toEqual([
      'tela-api started over a pull at 5',
      'delta at 10 sent folders, feedFolders, not held whole (a snapshot at 9 without folders, feedFolders)',
    ])
  })

  test('a start-over says why: a stored copy that does not load, and a copy another account took', async () => {
    // Storage says why it did not load the copy (`Persisted.dropped`), and the store tells it.
    const inner = memoryPersistence()
    const dropping: Persistence = {
      ...inner,
      load: async () => ({ ...(await inner.load()), dropped: 'load at 5: no kept record' }),
    }
    const heard: string[] = []
    const fresh = new LocalStore(dropping, () => NOW)
    fresh.onRestart = (why) => heard.push(why)
    await fresh.open()
    expect(heard).toEqual(['load at 5: no kept record'])

    const storage = memoryPersistence()
    const store = await member(storage)
    // A delta that brings everything it held, and the snapshot of a new device, say nothing.
    const told: string[] = []
    const later = new LocalStore(storage, () => NOW)
    later.onRestart = (why) => told.push(why)
    await later.open()
    await later.applyPull(pull(6, { articles: [article(9)] }), later.epoch)
    expect(told).toEqual([])
    // A delta from a tela-api without folders leaves them out of what the copy holds whole, and
    // a delta that brings them names that pull.
    const { folders: _f, feedFolders: _ff, ...old } = pull(7, {}).rows
    await later.applyPull({ ...pull(7, {}), rows: old as typeof snapshot.rows }, later.epoch)
    expect(await later.applyPull(pull(8, {}), later.epoch)).toBe(true)
    expect(told).toEqual([
      'delta at 7 sent folders, feedFolders, not held whole (a pull at 6 without folders, feedFolders)',
    ])
    // Another tab signed in as someone else, while this tab's /me still says a: the copy it
    // loaded is gone.
    told.length = 0
    await storage.claim('b')
    await later.setUser('a')
    expect(later.cursor).toBe(0)
    expect(told).toEqual(['claim: another account held the stored copy'])
    // Signing in as another account is not a start-over: the copy was someone else's.
    told.length = 0
    store.onRestart = (why) => told.push(why)
    await store.setUser('c')
    expect(told).toEqual([])
  })

  test('keeps an acknowledged change until a pull reaches it, then drops it', async () => {
    const store = await member()
    store.mutate({ type: 'markRead', articleId: 7 })
    const [m] = store.unsent()
    await store.acknowledge({ applied: [m?.mid ?? ''], rejected: [], seq: 9 }, store.epoch)
    expect(store.unsent()).toEqual([])
    expect(store.getSnapshot().pendingCount).toBe(1)
    await store.applyPull(
      pull(9, {
        states: [{ articleId: 7, readAt: NOW, likedAt: null, likedUpdatedAt: null, seq: 9 }],
      }),
      store.epoch,
    )
    expect(store.getSnapshot().pendingCount).toBe(0)
    expect(store.getSnapshot().tables.states.get(7)?.readAt).toBe(NOW)
  })

  test('a pull that brings nothing moves the cursor and keeps the snapshot', async () => {
    const storage = recording()
    const store = await member(storage)
    let heard = 0
    store.subscribe(() => heard++)
    const before = store.getSnapshot()
    expect(await store.applyPull(pull(6, {}), store.epoch)).toBe(false)
    // Other accounts' writes move the sequence too: the next pull starts past them.
    expect(store.cursor).toBe(6)
    const saved = await storage.load()
    expect(saved.cursor).toBe(6)
    expect(saved.covered).toEqual([...TABLES])
    expect(storage.saved.at(-1)).toEqual([])
    // Nothing on screen changed, so nothing re-renders.
    expect(store.getSnapshot()).toBe(before)
    expect(heard).toBe(0)
  })

  test('a pull that brings nothing still settles the changes it reaches', async () => {
    const storage = memoryPersistence()
    const store = await member(storage)
    store.mutate({ type: 'markRead', articleId: 7 })
    const [m] = store.unsent()
    await store.acknowledge({ applied: [m?.mid ?? ''], rejected: [], seq: 9 }, store.epoch)
    // A pull short of the change's seq keeps it, and the snapshot with it.
    const held = store.getSnapshot()
    await store.applyPull(pull(8, {}), store.epoch)
    expect(store.getSnapshot()).toBe(held)
    expect(store.getSnapshot().pendingCount).toBe(1)
    // One that reaches it drops it: the screen loses a pending count, so it renders again.
    await store.applyPull(pull(9, {}), store.epoch)
    expect(store.getSnapshot()).not.toBe(held)
    expect(store.getSnapshot().pendingCount).toBe(0)
    expect(store.cursor).toBe(9)
    const saved = await storage.load()
    expect(saved.cursor).toBe(9)
    expect(saved.pending).toEqual([])
  })

  test('a refused change is undone', async () => {
    const store = await member()
    store.mutate({ type: 'setLiked', articleId: 7, liked: true })
    const [m] = store.unsent()
    await store.acknowledge(
      { applied: [], rejected: [{ mid: m?.mid ?? '', error: 'invalid' }], seq: 6 },
      store.epoch,
    )
    expect(store.getSnapshot().tables.states.get(7)).toBeUndefined()
  })

  test('a change is unanswered until the server acknowledges or refuses it, held ones before it too', async () => {
    const store = await member()
    // A change held for an Undo keeps everything made after it from going (`unsent`).
    store.mutate({ type: 'markRead', articleId: 7 }, { holdMs: 5000 })
    const liked = store.mutate({ type: 'setLiked', articleId: 8, liked: true })
    const subscribed = store.mutate({ type: 'subscribe', feedId: 2 })
    expect(store.unsent()).toEqual([])
    expect(store.unanswered(subscribed?.mid ?? '')).toBe(true)
    store.releaseHolds()
    await store.acknowledge(
      {
        applied: [subscribed?.mid ?? ''],
        rejected: [{ mid: liked?.mid ?? '', error: 'invalid' }],
        seq: 9,
      },
      store.epoch,
    )
    expect(store.unanswered(subscribed?.mid ?? '')).toBe(false)
    expect(store.unanswered(liked?.mid ?? '')).toBe(false)
    expect(store.unanswered('never-made')).toBe(false)
  })

  test('a pull rewrites only the tables it touched', async () => {
    const storage = recording()
    const store = await member(storage)
    expect(storage.saved.at(-1)).toHaveLength(TABLES.length) // a snapshot writes every table
    await store.applyPull(pull(6, { articles: [article(9)] }), store.epoch)
    expect(storage.saved.at(-1)).toEqual(['articles'])
    // Unsubscribing prunes the feed's articles: no article row named them, yet they changed.
    await store.applyPull(
      pull(7, { subscriptions: [sub(1, { deletedAt: NOW, seq: 7 })] }),
      store.epoch,
    )
    expect(storage.saved.at(-1)).toEqual(['articles', 'subscriptions'])
  })

  test('reopens with everything it held, pending changes included', async () => {
    const storage = memoryPersistence()
    const first = await member(storage)
    first.mutate({ type: 'markRead', articleId: 8 })
    await new Promise((r) => setTimeout(r, 0))
    const again = new LocalStore(storage, () => NOW)
    await again.open()
    expect(again.userId).toBe('a')
    expect(again.hasData).toBe(true)
    expect(again.cursor).toBe(5)
    expect(again.getSnapshot().tables.states.get(8)?.readAt).toBe(NOW)
    expect(again.unsent()).toHaveLength(1)
  })

  test('two tabs each queue a change, and the device keeps both', async () => {
    // Two tabs share one storage; each holds only its own pending list in memory.
    const storage = memoryPersistence()
    const one = await member(storage)
    const two = new LocalStore(storage, () => NOW + 1)
    await two.open()
    one.mutate({ type: 'markRead', articleId: 7 })
    two.mutate({ type: 'markRead', articleId: 8 })
    await new Promise((r) => setTimeout(r, 0))
    const reopened = new LocalStore(storage, () => NOW)
    await reopened.open()
    expect(reopened.unsent().map((m) => m.type === 'markRead' && m.articleId)).toEqual([7, 8])

    // Each tab settles only its own; the other's stays until it is sent and caught up with.
    await one.acknowledge(
      { applied: one.unsent().map((m) => m.mid), rejected: [], seq: 6 },
      one.epoch,
    )
    await one.applyPull(pull(6, {}), one.epoch)
    const later = new LocalStore(storage, () => NOW)
    await later.open()
    expect(later.unsent().map((m) => m.type === 'markRead' && m.articleId)).toEqual([8])
  })

  test('another member signing in on this browser starts from nothing', async () => {
    const store = await member()
    store.remember([article(50, { feedId: 9 })], 'Elsewhere')
    expect(await store.setUser('a')).toBe(false)
    expect(store.hasData).toBe(true)
    expect(await store.setUser('b')).toBe(true)
    expect(store.hasData).toBe(false)
    expect(store.cursor).toBe(0)
    // What a's visit reached outside the synced feeds goes with the rest.
    expect(store.article(store.getSnapshot().tables, 50)).toBeUndefined()
    expect(store.sourceName(9)).toBe('')
  })

  test('holds a post from outside the synced feeds for this visit, under its blog name', async () => {
    const store = await member()
    const tables = store.getSnapshot().tables
    expect(store.article(tables, 50)).toBeUndefined()
    store.remember([article(50, { feedId: 9 })], 'Elsewhere')
    expect(store.article(tables, 50)?.feedId).toBe(9)
    expect(store.sourceName(9)).toBe('Elsewhere')
  })

  test('rows with no owner open as nothing', async () => {
    // What every earlier build left: all the rows, and whose they are nowhere it reads now.
    const name = `tela-store-${crypto.randomUUID()}`
    await seedEarlierBuild(name, snapshot)
    const store = new LocalStore(await indexedDbPersistence(name), () => NOW)
    await store.open()
    expect(store.userId).toBeNull()
    expect(store.hasData).toBe(false)
  })

  test('holding no account, it makes no change', async () => {
    const storage = memoryPersistence()
    const store = new LocalStore(storage, () => NOW)
    await store.open()
    let pushes = 0
    store.onMutation = () => pushes++
    expect(store.mutate({ type: 'markRead', articleId: 7 })).toBeNull()
    expect(store.mutate({ type: 'markRead', articleId: 7 }, { holdMs: 5000 })).toBeNull()
    expect(store.mutateMany([{ type: 'markRead', articleId: 7 }])).toEqual([])
    expect(store.unsent()).toEqual([])
    expect(pushes).toBe(0)
    expect((await storage.load()).pending).toEqual([])
  })
})

/** Timers a test runs by hand. */
function manualTimers(): Timers & { fire(): void; size(): number } {
  let next = 0
  const due = new Map<number, () => void>()
  return {
    set(run) {
      next += 1
      due.set(next, run)
      return next
    },
    clear: (handle) => void due.delete(handle as number),
    /** Run every timer still set, as if its time had come. */
    fire() {
      const now = [...due.values()]
      due.clear()
      for (const run of now) run()
    },
    size: () => due.size,
  }
}

/** Memory storage that records every pending change written, by id. */
function puts(): Persistence & { written: string[]; commits: number } {
  const inner = memoryPersistence()
  const out = {
    ...inner,
    written: [] as string[],
    commits: 0,
    commit: async (owner: string, change: Change) => {
      out.commits += 1
      for (const e of change.put ?? []) out.written.push(e.mutation.mid)
      return inner.commit(owner, change)
    },
  }
  return out
}

const tick = () => new Promise((r) => setTimeout(r, 0))
const HOLD = { holdMs: 5000 }
const markAll = { type: 'markAllRead', upTo: 8 } as const

/** A change the store made: a test that holds an account always gets one. */
function made(stamp: Stamp | null): Stamp {
  if (!stamp) throw new Error('no change was made')
  return stamp
}

describe('a change held back for an Undo', () => {
  /**
   * Account `a`'s store on recorded storage, with timers run by hand, a clock a millisecond on at
   * each look, and pushes counted.
   */
  async function holding() {
    const storage = puts()
    const timers = manualTimers()
    let clock = NOW
    const store = new LocalStore(storage, () => clock++, timers)
    await store.open()
    await store.setUser('a')
    await store.applyPull(snapshot, store.epoch)
    const pushes = { count: 0 }
    store.onMutation = () => void pushes.count++
    return { storage, timers, store, pushes }
  }
  const stored = async (storage: Persistence) =>
    (await storage.load()).pending.map((p) => p.mutation.mid)
  const watermark = (store: LocalStore) =>
    store.getSnapshot().tables.subscriptions.get(1)?.watermarkId

  test('shows at once, is not sent, and nothing made after it is sent before it', async () => {
    const { store, pushes } = await holding()
    const first = made(store.mutate({ type: 'setLiked', articleId: 7, liked: true }))
    const held = made(store.mutate(markAll, HOLD))
    store.mutate({ type: 'subscribe', feedId: 2 })
    expect(held).toEqual({ mid: expect.any(String), at: first.at + 1 })
    expect(watermark(store)).toBe(8)
    expect(store.getSnapshot().pendingCount).toBe(3)
    expect(store.unsent().map((m) => m.mid)).toEqual([first.mid])
    // Holding it asks for no push: there is nothing new to send.
    expect(pushes.count).toBe(2)
  })

  test('is stored only when its hold ends, and then goes to the server', async () => {
    const { storage, timers, store, pushes } = await holding()
    const held = made(store.mutate(markAll, HOLD))
    const after = made(store.mutate({ type: 'subscribe', feedId: 2 }))
    await tick()
    expect(storage.written).toEqual([after.mid])
    expect(timers.size()).toBe(1)
    pushes.count = 0

    timers.fire()
    await tick()
    expect(storage.written).toEqual([after.mid, held.mid])
    expect(pushes.count).toBe(1)
    expect(store.unsent().map((m) => m.mid)).toEqual([held.mid, after.mid])
    // Stored where the next boot loads it, in the order it was made.
    expect(await stored(storage)).toEqual([held.mid, after.mid])
  })

  test('an Undo before the hold ends takes it back, and nothing of it is ever stored', async () => {
    const { storage, timers, store, pushes } = await holding()
    const held = made(store.mutate(markAll, HOLD))
    const after = made(store.mutate({ type: 'subscribe', feedId: 2 }))
    pushes.count = 0
    expect(store.retract(held.mid)).toBe(true)
    expect(watermark(store)).toBe(0)
    expect(store.getSnapshot().pendingCount).toBe(1)
    // What it held back goes now.
    expect(store.unsent().map((m) => m.mid)).toEqual([after.mid])
    expect(pushes.count).toBe(1)
    expect(timers.size()).toBe(0)
    expect(store.retract(held.mid)).toBe(false)
    store.releaseHolds()
    await tick()
    expect(storage.written).toEqual([after.mid])

    // Once let go, it is on its way: too late to take back.
    const later = made(store.mutate(markAll, HOLD))
    timers.fire()
    expect(store.retract(later.mid)).toBe(false)
    expect(watermark(store)).toBe(8)
    expect(store.unsent().map((m) => m.mid)).toEqual([after.mid, later.mid])
  })

  test('letting every hold go stores them in one write, in order, and makes them sendable', async () => {
    const { storage, timers, store, pushes } = await holding()
    const one = made(store.mutate(markAll, HOLD))
    const two = made(store.mutate({ type: 'deleteHighlight', id: 'highlight-0000001' }, HOLD))
    await tick()
    const commits = storage.commits
    store.releaseHolds()
    expect(store.unsent().map((m) => m.mid)).toEqual([one.mid, two.mid])
    expect(timers.size()).toBe(0)
    expect(pushes.count).toBe(1)
    await tick()
    expect(storage.commits - commits).toBe(1)
    expect(await stored(storage)).toEqual([one.mid, two.mid])

    // Nothing left to let go: no write, no push.
    store.releaseHolds()
    await tick()
    expect(storage.commits - commits).toBe(1)
    expect(pushes.count).toBe(1)
  })

  test("signing in as someone else, or out, drops it: it is never stored as the next account's", async () => {
    const { storage, timers, store } = await holding()
    const held = made(store.mutate(markAll, HOLD))
    await store.setUser('b')
    expect(timers.size()).toBe(0)
    expect(store.unsent()).toEqual([])
    expect(store.retract(held.mid)).toBe(false)
    store.releaseHolds()
    await tick()
    expect(storage.written).toEqual([])
    expect((await storage.load()).owner).toBe('b')
    expect(await stored(storage)).toEqual([])

    const other = made(store.mutate(markAll, HOLD))
    await store.forgetAccount()
    expect(timers.size()).toBe(0)
    store.releaseHolds()
    await tick()
    expect(storage.written).not.toContain(other.mid)
  })

  test('a pull or an answer meanwhile keeps it, and stores nothing of it', async () => {
    const { storage, timers, store } = await holding()
    store.mutate({ type: 'markRead', articleId: 7 })
    const held = made(store.mutate(markAll, HOLD))
    const sent = store.unsent().map((m) => m.mid)
    await store.acknowledge({ applied: sent, rejected: [], seq: 9 }, store.epoch)
    expect(store.unsent()).toEqual([])
    await store.applyPull(
      pull(9, {
        states: [{ articleId: 7, readAt: NOW, likedAt: null, likedUpdatedAt: null, seq: 9 }],
      }),
      store.epoch,
    )
    // The answered change is caught up with and goes; the held one stays, shown and unsent.
    expect(store.getSnapshot().pendingCount).toBe(1)
    expect(watermark(store)).toBe(8)
    expect(store.unsent()).toEqual([])
    expect(timers.size()).toBe(1)
    await tick()
    expect(storage.written).not.toContain(held.mid)
    expect(await stored(storage)).toEqual([])

    timers.fire()
    await tick()
    expect(await stored(storage)).toEqual([held.mid])
    expect(store.unsent().map((m) => m.mid)).toEqual([held.mid])
  })

  test('several changes at once: one write, one push, each later than the last', async () => {
    // A clock that does not move between them, as within one millisecond.
    const storage = puts()
    const store = await member(storage, NOW)
    const pushes = { count: 0 }
    store.onMutation = () => void pushes.count++
    await tick()
    const commits = storage.commits
    const many = store.mutateMany([
      { type: 'markRead', articleId: 7 },
      { type: 'markRead', articleId: 8 },
      { type: 'setLiked', articleId: 7, liked: true },
    ])
    expect(many.map((s) => s.at)).toEqual([NOW, NOW + 1, NOW + 2])
    expect(store.unsent().map((m) => m.mid)).toEqual(many.map((s) => s.mid))
    expect(store.getSnapshot().tables.states.get(8)?.readAt).toBe(NOW + 1)
    expect(pushes.count).toBe(1)
    await tick()
    expect(storage.commits - commits).toBe(1)
    expect(await stored(storage)).toEqual(many.map((s) => s.mid))

    // An Undo that must come after the change it undoes, however the clocks stand.
    const undo = store.mutateMany(
      [
        { type: 'markUnread', articleId: 7 },
        { type: 'markUnread', articleId: 8 },
      ],
      { after: NOW + 10 },
    )
    expect(undo.map((s) => s.at)).toEqual([NOW + 11, NOW + 12])
    // An `after` already passed changes nothing: the next stamp is the next after the last.
    expect(store.mutateMany([{ type: 'markRead', articleId: 7 }], { after: NOW - 10 })).toEqual([
      { mid: expect.any(String), at: NOW + 13 },
    ])
    expect(store.mutateMany([])).toEqual([])
  })

  test('every change is stamped later than the one before, whatever the clock says', async () => {
    let clock = NOW
    const store = new LocalStore(memoryPersistence(), () => clock)
    await store.open()
    await store.setUser('a')
    // Within one millisecond.
    const one = made(store.mutate({ type: 'markRead', articleId: 7 }))
    const two = made(store.mutate({ type: 'markRead', articleId: 8 }))
    expect([one.at, two.at]).toEqual([NOW, NOW + 1])
    // A group runs its stamps ahead of the clock; a change made a moment after is later still,
    // so an Undo pressed then is not decided as made before what it undoes.
    const group = store.mutateMany([
      { type: 'markRead', articleId: 7 },
      { type: 'markRead', articleId: 8 },
      { type: 'setLiked', articleId: 7, liked: true },
    ])
    clock += 1
    const after = made(store.mutate({ type: 'markUnread', articleId: 7 }))
    expect(group.map((s) => s.at)).toEqual([NOW + 2, NOW + 3, NOW + 4])
    expect(after.at).toBe(NOW + 5)
    // Once the clock is ahead again, it is the clock's time.
    clock = NOW + 100
    expect(made(store.mutate({ type: 'markRead', articleId: 7 })).at).toBe(NOW + 100)
  })

  test('a folder whose deletion is held is still one, made here and unsent or not (ADR 0048)', async () => {
    const { store } = await holding()
    // Made on this device, so the server has never heard of it.
    store.mutate({ type: 'putFolder', id: 'folder-made-here', name: 'Cities' })
    const deleted = made(store.mutate({ type: 'deleteFolder', id: 'folder-made-here' }, HOLD))
    expect(store.getSnapshot().tables.folders.size).toBe(0)
    expect([...store.foldersBeforeHolds().values()].map((f) => f.name)).toEqual(['Cities'])
    // Once the deletion goes, the name and its place are free.
    store.release(deleted.mid)
    expect(store.foldersBeforeHolds().size).toBe(0)
  })

  test('release lets one held change go now: stored, then sent', async () => {
    const { storage, timers, store, pushes } = await holding()
    const one = made(store.mutate(markAll, HOLD))
    const two = made(store.mutate({ type: 'deleteHighlight', id: 'highlight-0000001' }, HOLD))
    pushes.count = 0
    store.release(one.mid)
    expect(pushes.count).toBe(1)
    // The one still held holds back nothing made before it.
    expect(store.unsent().map((m) => m.mid)).toEqual([one.mid])
    expect(timers.size()).toBe(1)
    await tick()
    expect(storage.written).toEqual([one.mid])
    expect(store.retract(one.mid)).toBe(false)

    // Again, or after an Undo took it back: nothing more.
    expect(store.retract(two.mid)).toBe(true)
    pushes.count = 0
    store.release(one.mid)
    store.release(two.mid)
    await tick()
    expect(storage.written).toEqual([one.mid])
    expect(pushes.count).toBe(0)
    expect(timers.size()).toBe(0)
  })

  test('a group held together: one timer, taken back or let go together', async () => {
    const { storage, timers, store, pushes } = await holding()
    const read = [7, 8].map((articleId) => ({ type: 'markRead', articleId }) as const)
    const group = store.mutateMany(read, HOLD)
    const mids = group.map((s) => s.mid)
    expect(timers.size()).toBe(1)
    expect(store.getSnapshot().tables.states.get(8)?.readAt).not.toBeNull()
    expect(store.unsent()).toEqual([])
    expect(pushes.count).toBe(0)
    await tick()
    expect(storage.written).toEqual([])
    // Only the whole group is taken back: a part of it says no and takes nothing.
    expect(store.retract(mids[0] ?? '', 'not-held')).toBe(false)
    expect(store.retract(...mids)).toBe(true)
    expect(store.getSnapshot().tables.states.get(8)?.readAt ?? null).toBeNull()
    expect(store.getSnapshot().pendingCount).toBe(0)
    expect(timers.size()).toBe(0)

    // Its timer lets every one of them go, in one write and one push.
    const again = store.mutateMany(read, HOLD)
    const commits = storage.commits
    timers.fire()
    expect(store.unsent().map((m) => m.mid)).toEqual(again.map((s) => s.mid))
    expect(pushes.count).toBe(1)
    await tick()
    expect(storage.commits - commits).toBe(1)
    expect(await stored(storage)).toEqual(again.map((s) => s.mid))

    // Released by hand, the timer goes with the last of them.
    const third = store.mutateMany(read, HOLD)
    store.release(...third.map((s) => s.mid))
    expect(timers.size()).toBe(0)
    expect(store.retract(...third.map((s) => s.mid))).toBe(false)
  })
})

describe('titles in the reading language only', () => {
  const ja = (id: number) => article(id, { sourceLang: 'ja' })
  /** A snapshot from a tela-api that sends every language, as one before `?titles=` does. */
  const everything = pull(
    5,
    {
      profile: [profile],
      subscriptions: [sub(1)],
      articles: [ja(7), ja(8)],
      titles: [title(7, 'en'), title(7, 'fr'), title(8, 'en'), title(8, 'fr')],
    },
    true,
  )
  const keys = (store: LocalStore) => [...store.getSnapshot().tables.titles.keys()].sort()
  const storedKeys = async (storage: Persistence) =>
    ((await storage.load()).rows?.titles ?? []).map((t) => `${t.articleId}:${t.lang}`).sort()

  async function reading(lang: string, storage: Persistence = memoryPersistence()) {
    const store = new LocalStore(storage, () => NOW)
    await store.open()
    await store.setUser('a')
    await store.applyPull(everything, store.epoch)
    store.setReadingLang(lang)
    await tick()
    return store
  }

  test('a copy that held every language keeps its reader’s, whole', async () => {
    const storage = memoryPersistence()
    const store = await reading('fr', storage)
    expect(keys(store)).toEqual(['7:fr', '8:fr'])
    expect(store.titlesWhole).toBe(true)
    expect(await storedKeys(storage)).toEqual(['7:fr', '8:fr'])
    expect((await storage.load()).titles).toEqual({ lang: 'fr', whole: true })
  })

  test('a switch lets the old language go at once, and the new one is fetched, never pulled again', async () => {
    const storage = memoryPersistence()
    const store = await reading('fr', storage)
    let told = 0
    store.onLanguage = () => void told++
    const round = store.titlesRound
    store.setReadingLang('en')
    // Shown as written until the new language's titles come.
    expect(keys(store)).toEqual([])
    expect(store.titlesWhole).toBe(false)
    expect(store.titlesRound).toBe(round + 1)
    expect(store.titleIds(0)).toEqual([7, 8])
    expect(store.cursor).toBe(5)
    expect(told).toBe(1)
    await tick()
    expect((await storage.load()).titles).toEqual({ lang: 'en', whole: false })
    expect(await storedKeys(storage)).toEqual([])
    // The same language again changes nothing.
    store.setReadingLang('en')
    expect(told).toBe(1)
  })

  test('fetched titles land in the tables as they are then, and not once the language moved', async () => {
    const storage = memoryPersistence()
    const store = await reading('fr', storage)
    store.setReadingLang('en')
    // A pull lands while the page is on its way.
    await store.applyPull(inLang(pull(6, { articles: [ja(9)] }), 'en'), store.epoch)
    await store.applyTitles([title(7, 'en', 3), title(8, 'fr', 3)], 'en', store.epoch)
    expect(keys(store)).toEqual(['7:en'])
    expect(store.getSnapshot().tables.articles.has(9)).toBe(true)
    expect(await storedKeys(storage)).toEqual(['7:en'])
    // A page asked for in French, landing after a switch to English, is dropped.
    await store.applyTitles([title(9, 'fr', 4)], 'fr', store.epoch)
    expect(keys(store)).toEqual(['7:en'])
    // Every page of the round asked for: whole, and stored so.
    await store.titlesFetched('en', store.epoch, store.titlesRound)
    expect(store.titlesWhole).toBe(true)
    expect((await storage.load()).titles).toEqual({ lang: 'en', whole: true })
  })

  test('a round that moved on is not whole when its pass ends', async () => {
    const store = await reading('fr')
    store.setReadingLang('en')
    const round = store.titlesRound
    // A pull asked for in French lands: it passed English rows it never brought.
    await store.applyPull(inLang(pull(6, { titles: [title(7, 'fr', 6)] }), 'fr'), store.epoch)
    expect(keys(store)).toEqual([])
    expect(store.titlesRound).toBe(round + 1)
    await store.titlesFetched('en', store.epoch, round)
    expect(store.titlesWhole).toBe(false)
  })

  test('a pull in the language held keeps it whole; one in another leaves it not', async () => {
    const storage = memoryPersistence()
    const store = await reading('fr', storage)
    await store.applyPull(inLang(pull(6, { titles: [title(7, 'fr', 6)] }), 'fr'), store.epoch)
    expect(store.titlesWhole).toBe(true)
    // A tela-api rolled back to before `?titles=`: every language, filtered here.
    await store.applyPull(pull(7, { titles: [title(8, 'fr', 7), title(8, 'en', 7)] }), store.epoch)
    expect(keys(store)).toEqual(['7:fr', '8:fr'])
    expect(store.titlesWhole).toBe(true)
    expect((await storage.load()).titles).toEqual({ lang: 'fr', whole: true })
    // Asked for before a switch elsewhere and answered in English: none of it is kept.
    await store.applyPull(inLang(pull(8, { titles: [title(7, 'en', 8)] }), 'en'), store.epoch)
    expect(keys(store)).toEqual(['7:fr', '8:fr'])
    expect(store.titlesWhole).toBe(false)
    expect((await storage.load()).titles).toEqual({ lang: 'fr', whole: false })
  })

  test('titles another tab’s cursor left out go with the next pull, and what they are with them', async () => {
    const storage = recording()
    const store = await reading('fr', storage)
    store.setReadingLang('en')
    await tick()
    // Another tab of the account pulls on, past this one.
    const other = new LocalStore(storage, () => NOW)
    await other.open()
    await other.applyPull(inLang(pull(9, {}), 'en'), other.epoch)
    // This tab's page of English titles cannot land at its own cursor, 5.
    await store.applyTitles([title(7, 'en', 2), title(8, 'en', 2)], 'en', store.epoch)
    expect(await storedKeys(storage)).toEqual([])
    // Its next pull, from 5 past 9, carries them, though it brought none.
    await store.applyPull(inLang(pull(10, {}), 'en'), store.epoch)
    expect(storage.saved.at(-1)).toEqual(['titles'])
    expect(await storedKeys(storage)).toEqual(['7:en', '8:en'])
    expect((await storage.load()).titles).toEqual({ lang: 'en', whole: false })
    // And the one after does not.
    await store.applyPull(inLang(pull(11, {}), 'en'), store.epoch)
    expect(storage.saved.at(-1)).toEqual([])
  })

  test('a copy stored before this build loads every language, and narrows to the reader’s, whole', async () => {
    const storage = memoryPersistence()
    await storage.claim('a')
    // As the build before it wrote it: every table, every language, and no word of titles.
    const tables = rowsOf(applyPull({ cursor: 0, tables: emptyTables() }, everything).tables)
    await storage.commit('a', { tables, cursor: 5, covered: TABLES })
    const booted = new LocalStore(storage, () => NOW)
    await booted.open()
    expect(booted.titleLang).toBeNull()
    expect(booted.titlesWhole).toBe(true)
    expect(keys(booted)).toEqual(['7:en', '7:fr', '8:en', '8:fr'])
    const round = booted.titlesRound
    booted.setReadingLang('en')
    expect(keys(booted)).toEqual(['7:en', '8:en'])
    expect(booted.titlesWhole).toBe(true)
    expect(booted.titlesRound).toBe(round)
    await tick()
    expect((await storage.load()).titles).toEqual({ lang: 'en', whole: true })
    expect(await storedKeys(storage)).toEqual(['7:en', '8:en'])
  })

  test('another account starts with no language until it is told', async () => {
    const store = await reading('fr')
    await store.setUser('b')
    expect(store.titleLang).toBeNull()
    expect(store.titlesWhole).toBe(false)
  })
})

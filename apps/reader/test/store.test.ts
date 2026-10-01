import 'fake-indexeddb/auto'
import { describe, expect, test } from 'bun:test'
import { indexedDbPersistence, memoryPersistence, type Persistence } from '../src/store/db'
import { LocalStore } from '../src/store/local'
import { seedEarlierBuild } from './earlier-build'
import { article, NOW, profile, pull, sub } from './rows'

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
async function member(storage: Persistence = memoryPersistence(), now = NOW) {
  const store = new LocalStore(storage, () => now)
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

  test('a pull rewrites only the tables it touched', async () => {
    const storage = recording()
    const store = await member(storage)
    expect(storage.saved.at(-1)).toHaveLength(13) // a snapshot writes every table
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
    store.mutate({ type: 'markRead', articleId: 7 })
    expect(store.unsent()).toEqual([])
    expect(pushes).toBe(0)
    expect((await storage.load()).pending).toEqual([])
  })
})

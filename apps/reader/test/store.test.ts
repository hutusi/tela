import { describe, expect, test } from 'bun:test'
import { memoryPersistence, type Persistence } from '../src/store/db'
import { LocalStore } from '../src/store/local'
import { article, NOW, profile, pull, sub } from './rows'

/** Memory storage that records which tables each save wrote. */
function recording(): Persistence & { saved: string[][] } {
  const inner = memoryPersistence()
  const saved: string[][] = []
  return {
    ...inner,
    saved,
    saveTables: async (rows) => {
      saved.push(Object.keys(rows).sort())
      await inner.saveTables(rows)
    },
  }
}

const snapshot = pull(
  5,
  { profile: [profile], subscriptions: [sub(1)], articles: [article(7), article(8)] },
  true,
)

describe('the device store', () => {
  test('shows a change the moment it is made, and queues it for the server', async () => {
    const store = new LocalStore(memoryPersistence(), () => NOW)
    await store.applyPull(snapshot)
    let pushes = 0
    store.onMutation = () => pushes++
    const before = store.getSnapshot()
    store.mutate({ type: 'setLiked', articleId: 7, liked: true })
    expect(store.getSnapshot()).not.toBe(before)
    expect(store.getSnapshot().tables.states.get(7)?.likedAt).toBe(NOW)
    expect(store.unsent()).toMatchObject([{ type: 'setLiked', articleId: 7, liked: true, at: NOW }])
    expect(pushes).toBe(1)
  })

  test('keeps an acknowledged change until a pull reaches it, then drops it', async () => {
    const store = new LocalStore(memoryPersistence(), () => NOW)
    await store.applyPull(snapshot)
    store.mutate({ type: 'markRead', articleId: 7 })
    const [m] = store.unsent()
    await store.acknowledge({ applied: [m?.mid ?? ''], rejected: [], seq: 9 })
    expect(store.unsent()).toEqual([])
    expect(store.getSnapshot().pendingCount).toBe(1)
    await store.applyPull(
      pull(9, {
        states: [{ articleId: 7, readAt: NOW, likedAt: null, likedUpdatedAt: null, seq: 9 }],
      }),
    )
    expect(store.getSnapshot().pendingCount).toBe(0)
    expect(store.getSnapshot().tables.states.get(7)?.readAt).toBe(NOW)
  })

  test('a refused change is undone', async () => {
    const store = new LocalStore(memoryPersistence(), () => NOW)
    await store.applyPull(snapshot)
    store.mutate({ type: 'setLiked', articleId: 7, liked: true })
    const [m] = store.unsent()
    await store.acknowledge({
      applied: [],
      rejected: [{ mid: m?.mid ?? '', error: 'invalid' }],
      seq: 6,
    })
    expect(store.getSnapshot().tables.states.get(7)).toBeUndefined()
  })

  test('a pull rewrites only the tables it touched', async () => {
    const storage = recording()
    const store = new LocalStore(storage, () => NOW)
    await store.applyPull(snapshot)
    expect(storage.saved.at(-1)).toHaveLength(11) // a snapshot writes every table
    await store.applyPull(pull(6, { articles: [article(9)] }))
    expect(storage.saved.at(-1)).toEqual(['articles'])
    // Unsubscribing prunes the feed's articles: no article row named them, yet they changed.
    await store.applyPull(pull(7, { subscriptions: [sub(1, { deletedAt: NOW, seq: 7 })] }))
    expect(storage.saved.at(-1)).toEqual(['articles', 'subscriptions'])
  })

  test('reopens with everything it held, pending changes included', async () => {
    const storage = memoryPersistence()
    const first = new LocalStore(storage, () => NOW)
    await first.applyPull(snapshot)
    first.mutate({ type: 'markRead', articleId: 8 })
    await new Promise((r) => setTimeout(r, 0))
    const again = new LocalStore(storage, () => NOW)
    await again.open()
    expect(again.hasData).toBe(true)
    expect(again.cursor).toBe(5)
    expect(again.getSnapshot().tables.states.get(8)?.readAt).toBe(NOW)
    expect(again.unsent()).toHaveLength(1)
  })

  test('another member signing in on this browser starts from nothing', async () => {
    const store = new LocalStore(memoryPersistence(), () => NOW)
    await store.setUser('a')
    await store.applyPull(snapshot)
    await store.setUser('a')
    expect(store.hasData).toBe(true)
    await store.setUser('b')
    expect(store.hasData).toBe(false)
    expect(store.cursor).toBe(0)
  })

  test('holds a post from outside the synced feeds for this visit, under its blog name', async () => {
    const store = new LocalStore(memoryPersistence(), () => NOW)
    await store.applyPull(snapshot)
    const tables = store.getSnapshot().tables
    expect(store.article(tables, 50)).toBeUndefined()
    store.remember([article(50, { feedId: 9 })], 'Elsewhere')
    expect(store.article(tables, 50)?.feedId).toBe(9)
    expect(store.sourceName(9)).toBe('Elsewhere')
  })
})

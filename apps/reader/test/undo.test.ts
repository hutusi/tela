/**
 * Undo tied to its toast (ADR 0046): the change stays held while the toast shows, goes when the
 * toast goes, and an Undo pressed after it went anyway undoes it another way.
 */
import { afterEach, beforeEach, describe, expect, jest, test } from 'bun:test'
import type { HighlightRow } from '@tela/sync'
import { currentToast, dismissToast, runToastAction, showToast, UNDO_MS } from '../src/lib/toasts'
import { highlightAgain, offerUndo, UNDO_UNREAD_MAX, unreadAgain } from '../src/lib/undo'
import { memoryPersistence } from '../src/store/db'
import { LocalStore, type Stamp, type Timers } from '../src/store/local'
import { article, NOW, profile, pull, sub } from './rows'

/** Store timers that never run by themselves: here, only the toast lets a hold go. */
const never: Timers = { set: () => 0, clear() {} }
const BACKSTOP = { holdMs: 30_000 }
const markAll = { type: 'markAllRead', upTo: 8 } as const

async function member() {
  const storage = memoryPersistence()
  const store = new LocalStore(storage, () => NOW, never)
  await store.open()
  await store.setUser('a')
  await store.applyPull(
    pull(
      5,
      { profile: [profile], subscriptions: [sub(1)], articles: [article(7), article(8)] },
      true,
    ),
    store.epoch,
  )
  const pushes = { count: 0 }
  store.onMutation = () => void pushes.count++
  return { storage, store, pushes }
}

function made(stamp: Stamp | null): Stamp {
  if (!stamp) throw new Error('no change was made')
  return stamp
}

const watermark = (store: LocalStore) =>
  store.getSnapshot().tables.subscriptions.get(1)?.watermarkId
const tick = () => new Promise((r) => setTimeout(r, 0))

describe('an Undo offered for a held change', () => {
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => {
    dismissToast()
    jest.useRealTimers()
  })

  test('pressed while the toast shows, takes the change back and sends nothing', async () => {
    const { storage, store, pushes } = await member()
    const held = made(store.mutate(markAll, BACKSTOP))
    let late = 0
    const id = offerUndo(store, 'Marked 2 posts read.', 'Undo', [held.mid], () => late++)
    runToastAction(id)
    expect(late).toBe(0)
    expect(watermark(store)).toBe(0)
    expect(store.getSnapshot().pendingCount).toBe(0)
    expect(pushes.count).toBe(0)
    expect((await storage.load()).pending).toEqual([])
  })

  test('held for as long as the toast shows, and sent once it goes', async () => {
    const { store, pushes } = await member()
    const held = made(store.mutate(markAll, BACKSTOP))
    offerUndo(store, 'Marked 2 posts read.', 'Undo', [held.mid], () => {})
    jest.advanceTimersByTime(UNDO_MS - 1)
    expect(store.unsent()).toEqual([])
    jest.advanceTimersByTime(1)
    expect(currentToast()).toBeNull()
    expect(store.unsent().map((m) => m.mid)).toEqual([held.mid])
    expect(pushes.count).toBe(1)
  })

  test('replaced by another message, or dismissed, it lets the change go too', async () => {
    const { store } = await member()
    const one = made(store.mutate(markAll, BACKSTOP))
    offerUndo(store, 'Marked 2 posts read.', 'Undo', [one.mid], () => {})
    showToast('Recommended.')
    expect(store.unsent().map((m) => m.mid)).toEqual([one.mid])

    const two = made(store.mutate({ type: 'deleteHighlight', id: 'highlight-0000001' }, BACKSTOP))
    const id = offerUndo(store, 'Highlight removed.', 'Undo', [two.mid], () => {})
    dismissToast(id)
    expect(store.unsent().map((m) => m.mid)).toEqual([one.mid, two.mid])
  })

  test('pressed after the change went anyway, undoes it the late way', async () => {
    const { store } = await member()
    const held = made(store.mutate(markAll, BACKSTOP))
    let late = 0
    const id = offerUndo(store, 'Marked 2 posts read.', 'Undo', [held.mid], () => late++)
    // The tab was hidden meanwhile: every hold went.
    store.releaseHolds()
    runToastAction(id)
    expect(late).toBe(1)
    expect(watermark(store)).toBe(8)
  })

  test('pressed once the tab holds another account, does nothing', async () => {
    const { store } = await member()
    const held = made(store.mutate(markAll, BACKSTOP))
    let late = 0
    const id = offerUndo(store, 'Marked 2 posts read.', 'Undo', [held.mid], () => late++)
    await store.setUser('b')
    runToastAction(id)
    expect(late).toBe(0)
    expect(store.unsent()).toEqual([])
  })

  test('a group is taken back whole', async () => {
    const { store } = await member()
    const group = store.mutateMany(
      [7, 8].map((articleId) => ({ type: 'markRead', articleId }) as const),
      BACKSTOP,
    )
    const id = offerUndo(
      store,
      'Marked 2 posts read.',
      'Undo',
      group.map((s) => s.mid),
      () => {},
    )
    runToastAction(id)
    expect(store.getSnapshot().pendingCount).toBe(0)
    expect(store.getSnapshot().tables.states.get(7)?.readAt ?? null).toBeNull()
  })
})

describe('the late way', () => {
  test('marks unread what a mark-all read, one by one and after it, up to the cap', async () => {
    const { store } = await member()
    const sent = made(store.mutate(markAll))
    await tick()
    expect(unreadAgain(store, [7, 8], sent.at)).toBe(true)
    const undo = store.unsent().slice(1)
    expect(undo.map((m) => m.type)).toEqual(['markUnread', 'markUnread'])
    expect(undo.every((m) => m.at > sent.at)).toBe(true)

    // Past the cap, nothing is made: the caller says so instead.
    const many = Array.from({ length: UNDO_UNREAD_MAX + 1 }, (_, i) => i + 1)
    const before = store.getSnapshot().pendingCount
    expect(unreadAgain(store, many, sent.at)).toBe(false)
    expect(store.getSnapshot().pendingCount).toBe(before)
    expect(unreadAgain(store, many.slice(1), sent.at)).toBe(true)
  })

  test('a removed highlight comes back as it was, under a new id', () => {
    const row: HighlightRow = {
      id: 'highlight-0000001',
      articleId: 7,
      contentKey: '0123456789abcdef0123456789abcdef',
      side: 'translation',
      lang: 'fr',
      leafId: 'b3',
      start: 4,
      end: 19,
      quote: 'garden teaches',
      prefix: 'The ',
      suffix: ' patience',
      note: 'A note.',
      createdAt: NOW,
      updatedAt: NOW,
      deletedAt: null,
      seq: 3,
    }
    expect(highlightAgain(row, 'highlight-0000002')).toEqual({
      type: 'putHighlight',
      id: 'highlight-0000002',
      articleId: 7,
      contentKey: '0123456789abcdef0123456789abcdef',
      side: 'translation',
      lang: 'fr',
      leafId: 'b3',
      start: 4,
      end: 19,
      quote: 'garden teaches',
      prefix: 'The ',
      suffix: ' patience',
      note: 'A note.',
    })
    expect(highlightAgain(row)).toMatchObject({ type: 'putHighlight', quote: 'garden teaches' })
    expect((highlightAgain(row) as { id: string }).id).not.toBe(row.id)
  })
})

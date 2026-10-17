/** Which folders this device shows closed (ADR 0048): kept in localStorage, as the panes are. */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import {
  CLOSED_MAX,
  closedFolders,
  setFolderOpen,
  subscribeFolders,
  toggleFolder,
} from '../src/lib/folders-open'

const KEY = 'tela.folders.closed'
const saved = { localStorage: globalThis.localStorage, window: globalThis.window }
const held = new Map<string, string>()
const storageListeners = new Set<(e: StorageEvent) => void>()
const store = {
  getItem: (k: string) => held.get(k) ?? null,
  setItem: (k: string, v: string) => void held.set(k, v),
  removeItem: (k: string) => void held.delete(k),
}
beforeAll(() => {
  Object.assign(globalThis, {
    localStorage: store,
    window: {
      addEventListener: (_: 'storage', fn: (e: StorageEvent) => void) =>
        void storageListeners.add(fn),
      removeEventListener: (_: 'storage', fn: (e: StorageEvent) => void) =>
        void storageListeners.delete(fn),
    },
  })
})
afterAll(() => {
  Object.assign(globalThis, saved)
})

/** What another tab's write looks like from here: the event, never the write itself. */
function storageEvent(key: string | null) {
  for (const l of storageListeners) l({ key } as StorageEvent)
}
/** Drop the module's cache the way a `clear()` elsewhere would. */
function forget() {
  closedFolders()
  storageEvent(null)
}
const closed = () => [...closedFolders()]

describe('the folders this device shows closed', () => {
  test('start with every folder open, and a value this build cannot read closes none', () => {
    held.clear()
    forget()
    expect(closed()).toEqual([])
    for (const raw of ['not json', '{"f-1":true}', '"f-1"', 'null']) {
      held.set(KEY, raw)
      forget()
      expect(closed(), raw).toEqual([])
    }
    // Ids kept as strings, anything else in the array left out.
    held.set(KEY, JSON.stringify(['f-cities-1', 7, null, 'f-craft-2']))
    forget()
    expect(closed()).toEqual(['f-cities-1', 'f-craft-2'])
  })

  test('closing and opening is written to the device and told to whoever is listening', () => {
    held.clear()
    forget()
    let told = 0
    const stop = subscribeFolders(() => {
      told += 1
    })
    toggleFolder('f-cities-1')
    expect(held.get(KEY)).toBe('["f-cities-1"]')
    expect(closedFolders().has('f-cities-1')).toBe(true)
    expect(told).toBe(1)
    setFolderOpen('f-craft-2', false)
    expect(closed()).toEqual(['f-cities-1', 'f-craft-2'])
    // Asked for what it already is, nothing changes and nobody is told.
    const before = closedFolders()
    setFolderOpen('f-craft-2', false)
    setFolderOpen('f-never-3', true)
    expect(closedFolders()).toBe(before)
    expect(told).toBe(2)
    // The toggle reads the state when it runs: a second press opens it again.
    toggleFolder('f-cities-1')
    expect(closed()).toEqual(['f-craft-2'])
    expect(held.get(KEY)).toBe('["f-craft-2"]')
    expect(told).toBe(3)
    stop()
    toggleFolder('f-craft-2')
    expect(told, 'told after unsubscribing').toBe(3)
    expect(closed()).toEqual([])
  })

  test('the same answer until something changes it, so a render can compare by identity', () => {
    held.clear()
    forget()
    const first = closedFolders()
    expect(closedFolders()).toBe(first)
    setFolderOpen('f-cities-1', false)
    expect(closedFolders()).not.toBe(first)
  })

  test('another tab’s choice arrives through its storage event, and only for our key', () => {
    held.clear()
    forget()
    expect(closed()).toEqual([])
    held.set(KEY, '["f-cities-1"]')
    // The cache does not see the write itself.
    expect(closed()).toEqual([])
    let told = 0
    const stop = subscribeFolders(() => {
      told += 1
    })
    storageEvent('tela.sidebar')
    expect(told).toBe(0)
    storageEvent(KEY)
    expect(told).toBe(1)
    expect(closed()).toEqual(['f-cities-1'])
    stop()
    // And one listener for the module's life, however many times the page subscribed.
    expect(storageListeners.size).toBe(1)
  })

  test('keeps the most recently closed when it grows past its bound', () => {
    held.clear()
    forget()
    for (let i = 0; i < CLOSED_MAX + 5; i++) setFolderOpen(`f-folder-${i}`, false)
    const kept = JSON.parse(held.get(KEY) ?? '[]') as string[]
    expect(kept).toHaveLength(CLOSED_MAX)
    expect(kept[0]).toBe('f-folder-5')
    expect(kept.at(-1)).toBe(`f-folder-${CLOSED_MAX + 4}`)
    expect(closedFolders().has('f-folder-0')).toBe(false)
    held.clear()
    forget()
  })

  test('a store that refuses leaves every folder open, and a choice holds for the session', () => {
    held.clear()
    forget()
    const refusing = {
      getItem: () => {
        throw new Error('denied')
      },
      setItem: () => {
        throw new Error('denied')
      },
    }
    Object.assign(globalThis, { localStorage: refusing })
    try {
      expect(closed()).toEqual([])
      setFolderOpen('f-cities-1', false)
      expect(closed()).toEqual(['f-cities-1'])
    } finally {
      Object.assign(globalThis, { localStorage: store })
      forget()
    }
  })
})

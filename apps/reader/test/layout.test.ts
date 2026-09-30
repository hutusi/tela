/** The panes this device shows (ADR 0029): kept in localStorage, in the shape of the synced prefs. */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { gridColumns, layout, setLayout, subscribeLayout, toggleSidebar } from '../src/lib/layout'

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
  const stop = subscribeLayout(() => {})
  storageEvent(null)
  stop()
}

describe('the panes this device shows', () => {
  test('start shown, and a value this build does not know is the default too', () => {
    forget()
    expect(layout().sidebar).toBe('shown')
    held.set('tela.sidebar', 'sideways')
    forget()
    expect(layout().sidebar).toBe('shown')
  })

  test('a choice is written to the device and told to whoever is listening', () => {
    forget()
    let told = 0
    const stop = subscribeLayout(() => {
      told += 1
    })
    toggleSidebar()
    expect(held.get('tela.sidebar')).toBe('hidden')
    expect(layout().sidebar).toBe('hidden')
    expect(told).toBe(1)
    stop()
    setLayout({ sidebar: 'shown' })
    expect(told, 'told after unsubscribing').toBe(1)
    expect(layout().sidebar).toBe('shown')
  })

  test('another tab’s choice arrives through its storage event, and only for our keys', () => {
    forget()
    expect(layout().sidebar).toBe('shown')
    held.set('tela.sidebar', 'hidden')
    // The cache does not see the write itself.
    expect(layout().sidebar).toBe('shown')
    let told = 0
    const stop = subscribeLayout(() => {
      told += 1
    })
    storageEvent('tela.theme')
    expect(told).toBe(0)
    storageEvent('tela.sidebar')
    expect(told).toBe(1)
    expect(layout().sidebar).toBe('hidden')
    stop()
  })

  test('a store that refuses leaves the defaults, and the choice still holds for the session', () => {
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
      expect(layout().sidebar).toBe('shown')
      setLayout({ sidebar: 'hidden' })
      expect(layout().sidebar).toBe('hidden')
    } finally {
      Object.assign(globalThis, { localStorage: store })
      forget()
    }
  })
})

describe('the grid', () => {
  test('loses the sidebar column with the sidebar, and narrows the list while an article is open', () => {
    expect(gridColumns(false, { sidebar: 'shown' })).toBe(
      'lg:grid-cols-[220px_minmax(280px,380px)_minmax(0,1fr)]',
    )
    expect(gridColumns(true, { sidebar: 'shown' })).toBe('lg:grid-cols-[220px_260px_minmax(0,1fr)]')
    expect(gridColumns(false, { sidebar: 'hidden' })).toBe(
      'lg:grid-cols-[minmax(280px,380px)_minmax(0,1fr)]',
    )
    expect(gridColumns(true, { sidebar: 'hidden' })).toBe('lg:grid-cols-[260px_minmax(0,1fr)]')
  })
})

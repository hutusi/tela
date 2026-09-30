/** The panes this device shows (ADR 0029): kept in localStorage, in the shape of the synced prefs. */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import {
  gridColumns,
  layout,
  setLayout,
  subscribeLayout,
  toggleFocus,
  toggleSidebar,
} from '../src/lib/layout'

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
  layout()
  storageEvent(null)
}

describe('the panes this device shows', () => {
  test('start shown and unfocused, and a value this build does not know is the default too', () => {
    held.clear()
    forget()
    expect(layout()).toEqual({ sidebar: 'shown', focus: 'off' })
    held.set('tela.sidebar', 'sideways')
    held.set('tela.focus', 'sharp')
    forget()
    expect(layout()).toEqual({ sidebar: 'shown', focus: 'off' })
  })

  test('a choice is written to the device and told to whoever is listening', () => {
    held.clear()
    forget()
    let told = 0
    const stop = subscribeLayout(() => {
      told += 1
    })
    toggleSidebar()
    expect(held.get('tela.sidebar')).toBe('hidden')
    expect(layout().sidebar).toBe('hidden')
    expect(told).toBe(1)
    toggleFocus()
    expect(held.get('tela.focus')).toBe('on')
    expect(layout()).toEqual({ sidebar: 'hidden', focus: 'on' })
    expect(told).toBe(2)
    stop()
    setLayout({ sidebar: 'shown', focus: 'off' })
    expect(told, 'told after unsubscribing').toBe(2)
    expect(layout()).toEqual({ sidebar: 'shown', focus: 'off' })
  })

  test('another tab’s choice arrives through its storage event, and only for our keys', () => {
    held.clear()
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

  test('another tab’s choice is not missed while nobody here is listening', () => {
    // A tab on Settings has no subscriber. It must still come back to /reading with the layout the
    // other tab chose meanwhile, not the one it left with.
    held.clear()
    forget()
    expect(layout().sidebar).toBe('shown')
    held.set('tela.sidebar', 'hidden')
    storageEvent('tela.sidebar')
    expect(layout().sidebar).toBe('hidden')
    // And one listener for the module's life, however many times the page subscribed.
    expect(storageListeners.size).toBe(1)
  })

  test('a store that refuses leaves the defaults, and the choice still holds for the session', () => {
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
    const shown = { sidebar: 'shown', focus: 'off' } as const
    const hidden = { sidebar: 'hidden', focus: 'off' } as const
    expect(gridColumns(false, shown)).toBe('lg:grid-cols-[220px_minmax(280px,380px)_minmax(0,1fr)]')
    expect(gridColumns(true, shown)).toBe('lg:grid-cols-[220px_260px_minmax(0,1fr)]')
    expect(gridColumns(false, hidden)).toBe('lg:grid-cols-[minmax(280px,380px)_minmax(0,1fr)]')
    expect(gridColumns(true, hidden)).toBe('lg:grid-cols-[260px_minmax(0,1fr)]')
  })

  test('in focus an open article has the grid to itself, and a closed one does not', () => {
    const focus = { sidebar: 'shown', focus: 'on' } as const
    expect(gridColumns(true, focus)).toBe('lg:grid-cols-[minmax(0,1fr)]')
    expect(gridColumns(false, focus)).toBe('lg:grid-cols-[220px_minmax(280px,380px)_minmax(0,1fr)]')
    expect(gridColumns(true, { sidebar: 'hidden', focus: 'on' })).toBe(
      'lg:grid-cols-[minmax(0,1fr)]',
    )
  })
})

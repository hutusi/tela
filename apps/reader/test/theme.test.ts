/** The theme switch (ADR 0037): the page as it is, the other theme, and a visitor's choice kept. */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import type { PrefRow } from '@tela/sync'
import {
  applyTheme,
  deviceTheme,
  PREFS,
  pressThemeSwitch,
  shownTheme,
  type Theme,
  themeToAdopt,
  typographyOf,
} from '../src/lib/typography'
import { memoryPersistence } from '../src/store/db'
import { LocalStore } from '../src/store/local'
import { NOW, profile, pull } from './rows'

const saved = {
  document: globalThis.document,
  window: globalThis.window,
  localStorage: globalThis.localStorage,
}
const dataset: Record<string, string> = {}
/** What the system asks for, as `prefers-color-scheme` would say it. */
let systemDark = false
const held = new Map<string, string>()
/** Every value written, in order, to see what was never written. */
let written: string[] = []
const storage = {
  getItem: (k: string) => held.get(k) ?? null,
  setItem: (k: string, v: string) => {
    written.push(v)
    held.set(k, v)
  },
}
beforeAll(() => {
  Object.assign(globalThis, {
    document: { documentElement: { dataset } },
    window: {
      matchMedia: (query: string) => ({
        matches: query === '(prefers-color-scheme: dark)' && systemDark,
      }),
    },
    localStorage: storage,
  })
})
afterAll(() => {
  Object.assign(globalThis, saved)
})
beforeEach(() => {
  delete dataset.theme
  systemDark = false
  held.clear()
  written = []
})

const prefs = (value?: unknown) => ({
  prefs: new Map<string, PrefRow>(
    value === undefined ? [] : [[PREFS.theme, { key: PREFS.theme, value, updatedAt: 1, seq: 1 }]],
  ),
})

describe('the theme the page shows', () => {
  test("is the page's own choice, over the system's", () => {
    systemDark = true
    dataset.theme = 'light'
    expect(shownTheme()).toBe('light')
    systemDark = false
    dataset.theme = 'dark'
    expect(shownTheme()).toBe('dark')
  })

  test("is the system's without a choice, or with one this build does not know", () => {
    systemDark = true
    expect(shownTheme()).toBe('dark')
    systemDark = false
    expect(shownTheme()).toBe('light')
    dataset.theme = 'sepia'
    systemDark = true
    expect(shownTheme()).toBe('dark')
  })

  test('following the system is no choice on the page, and is kept as one on the device', () => {
    applyTheme('dark')
    expect(dataset.theme).toBe('dark')
    applyTheme('system')
    expect('theme' in dataset).toBe(false)
    expect(held.get('tela.theme')).toBe('system')
  })
})

/** A device holding no account: a visitor's. */
async function visitor() {
  const store = new LocalStore(memoryPersistence(), () => NOW)
  await store.open()
  return store
}

/** A device holding account `a`, synced, whose theme row (if any) was written at `NOW`. */
async function member(held: string | null, clock = NOW) {
  const store = new LocalStore(memoryPersistence(), () => clock)
  await store.open()
  await store.setUser('a')
  const prefs = held === null ? [] : [{ key: PREFS.theme, value: held, updatedAt: NOW, seq: 4 }]
  await store.applyPull(pull(5, { profile: [profile], prefs }, true), store.epoch)
  return store
}

const stored = (store: LocalStore) => typographyOf(store.getSnapshot().tables).theme

describe("a visitor's switch", () => {
  test('goes from the dark a system shows to light, then back to dark, and never to system', async () => {
    const store = await visitor()
    systemDark = true
    applyTheme('system')
    written = []
    pressThemeSwitch(store)
    expect(dataset.theme).toBe('light')
    expect(held.get('tela.theme')).toBe('light')
    pressThemeSwitch(store)
    expect(dataset.theme).toBe('dark')
    expect(held.get('tela.theme')).toBe('dark')
    expect(written).toEqual(['light', 'dark'])
    // Nothing is queued for a server: it is no one's.
    expect(store.unsent()).toEqual([])
  })

  test('answers for the page as it is when pressed, whoever changed it since', async () => {
    const store = await visitor()
    pressThemeSwitch(store)
    expect(dataset.theme).toBe('dark')
    // Another tab or the device put the page back to light in between.
    applyTheme('light')
    pressThemeSwitch(store)
    expect(dataset.theme).toBe('dark')
    // And to following a system that has gone dark.
    applyTheme('system')
    systemDark = true
    pressThemeSwitch(store)
    expect(dataset.theme).toBe('light')
  })
})

describe("a member's switch", () => {
  test('is their synced pref, and the page shows it', async () => {
    const store = await member(null)
    pressThemeSwitch(store)
    expect(stored(store)).toBe('dark')
    expect(dataset.theme).toBe('dark')
    expect(store.unsent()).toMatchObject([{ type: 'setPref', key: PREFS.theme, value: 'dark' }])
    pressThemeSwitch(store)
    expect(stored(store)).toBe('light')
    expect(dataset.theme).toBe('light')
  })

  // Codex review: with the browser's clock a minute behind, the press loses to the dark chosen at
  // NOW, and a page painted from the press showed light while Settings and the server said dark,
  // for good, since the pref never changed to put it right.
  test('that loses to a later choice leaves the page as the pref has it', async () => {
    const store = await member('dark', NOW - 60_000)
    applyTheme('dark')
    pressThemeSwitch(store)
    expect(stored(store)).toBe('dark')
    expect(dataset.theme).toBe('dark')
  })
})

describe("this device's theme", () => {
  test('is what was kept, or system for nothing, or for a value this build does not know', () => {
    expect(deviceTheme()).toBe('system')
    for (const theme of ['light', 'dark', 'system'] as const) {
      held.set('tela.theme', theme)
      expect(deviceTheme()).toBe(theme)
    }
    held.set('tela.theme', 'sepia')
    expect(deviceTheme()).toBe('system')
  })

  test('is system when the storage refuses', async () => {
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
      expect(deviceTheme()).toBe('system')
      // And a choice still reaches the page.
      pressThemeSwitch(await visitor())
      expect(dataset.theme).toBe('dark')
    } finally {
      Object.assign(globalThis, { localStorage: storage })
    }
  })
})

describe('what an account takes from the device', () => {
  test("a visitor's light or dark, when the account has never chosen", () => {
    expect(themeToAdopt(prefs(), 'dark')).toBe('dark')
    expect(themeToAdopt(prefs(), 'light')).toBe('light')
  })

  test('nothing when the device only follows the system', () => {
    expect(themeToAdopt(prefs(), 'system')).toBeNull()
  })

  test("nothing over the account's own row, whatever it says", () => {
    const devices: Theme[] = ['light', 'dark', 'system']
    for (const value of ['light', 'dark', 'system', 'sepia', null]) {
      for (const device of devices) expect(themeToAdopt(prefs(value), device)).toBeNull()
    }
  })
})

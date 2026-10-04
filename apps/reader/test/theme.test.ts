/** The theme switch (ADR 0037): the page as it is, the other theme, and a visitor's choice kept. */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import type { PrefRow } from '@tela/sync'
import {
  applyTheme,
  deviceTheme,
  flipTheme,
  PREFS,
  shownTheme,
  type Theme,
  themeToAdopt,
} from '../src/lib/typography'

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

describe('the switch', () => {
  test('goes from the dark a system shows to light, then back to dark, and never to system', () => {
    systemDark = true
    applyTheme('system')
    written = []
    expect(flipTheme()).toBe('light')
    expect(dataset.theme).toBe('light')
    expect(held.get('tela.theme')).toBe('light')
    expect(flipTheme()).toBe('dark')
    expect(dataset.theme).toBe('dark')
    expect(held.get('tela.theme')).toBe('dark')
    expect(written).toEqual(['light', 'dark'])
  })

  test('answers for the page as it is when pressed, whoever changed it since', () => {
    expect(flipTheme()).toBe('dark')
    // Settings, the Aa menu or a sync put the page back to light in between.
    applyTheme('light')
    expect(flipTheme()).toBe('dark')
    // And to following a system that has gone dark.
    applyTheme('system')
    systemDark = true
    expect(flipTheme()).toBe('light')
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

  test('is system when the storage refuses', () => {
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
      expect(flipTheme()).toBe('dark')
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

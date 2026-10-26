/**
 * The header's language circle (ADR 0040): what it shows, what a choice changes, and what an
 * account takes from the browser its visitor chose a language on.
 */
import { describe, expect, test } from 'bun:test'
import { READING_LANGUAGES } from '@tela/shared'
import { type ProfileRow, readingLangOf } from '@tela/sync'
import {
  bootLocale,
  chooseLocale,
  chosenLocale,
  detectLocale,
  localeToAdopt,
  pinnedLocale,
  requestLocale,
} from '../src/i18n'
import { circleLabel, pillLabel } from '../src/lib/format'
import { memoryPersistence } from '../src/store/db'
import { LocalStore } from '../src/store/local'
import { NOW, profile, pull } from './rows'

describe('the language circle', () => {
  test('shows each language in a character or two, each Chinese in its own script', () => {
    expect(READING_LANGUAGES.map(circleLabel)).toEqual(['简', '繁', 'EN', 'FR'])
  })

  test('fits the circle: one Chinese character, or two Latin letters', () => {
    for (const code of READING_LANGUAGES) {
      const label = circleLabel(code)
      expect(label.length === 1 || /^[A-Z]{2}$/.test(label), `${code}: ${label}`).toBe(true)
    }
  })

  test('falls back to the badge for a language it has no label for', () => {
    expect(circleLabel('ja')).toBe('JA')
  })

  test("leaves the pill's longer labels to the admin console", () => {
    expect(READING_LANGUAGES.map(pillLabel)).toEqual(['简体', '繁體', 'EN', 'FR'])
  })
})

/** A device holding no account: a visitor's. */
async function visitor() {
  const store = new LocalStore(memoryPersistence(), () => NOW)
  await store.open()
  return store
}

/** A device holding account `a`, synced with `over` on its profile, its clock at `clock`. */
async function member(over: Partial<ProfileRow> | null, clock = NOW) {
  const store = new LocalStore(memoryPersistence(), () => clock)
  await store.open()
  await store.setUser('a')
  if (over) {
    await store.applyPull(pull(5, { profile: [{ ...profile, ...over }] }, true), store.epoch)
  }
  return store
}

const held = (store: LocalStore) => store.getSnapshot().tables.profile

describe('an interface language chosen', () => {
  test("by a visitor goes on the page, and is no one else's", async () => {
    const store = await visitor()
    expect(chooseLocale(store, 'fr')).toBe('fr')
    expect(store.unsent()).toEqual([])
  })

  test("by a member is their profile's, and the page shows it", async () => {
    const store = await member({ uiLocale: 'en', uiLocaleAt: NOW - 1000 })
    expect(chooseLocale(store, 'zh-Hant')).toBe('zh-Hant')
    expect(held(store)?.uiLocale).toBe('zh-Hant')
    expect(store.unsent()).toMatchObject([{ type: 'setProfile', uiLocale: 'zh-Hant' }])
    // Linked: the translation language stays null, and follows.
    expect(held(store)?.readingLang).toBeNull()
  })

  // The theme's bug of ADR 0037 again: with this device's clock a minute behind the French chosen
  // elsewhere at NOW, the choice loses, and a page painted from it would be in English while the
  // account, Settings and every other device said French, for good.
  test('that loses to a later one leaves the page as the account has it', async () => {
    const store = await member({ uiLocale: 'fr', uiLocaleAt: NOW }, NOW - 60_000)
    expect(chooseLocale(store, 'en')).toBe('fr')
    expect(held(store)?.uiLocale).toBe('fr')
    // Sent all the same: the server decides, and its row comes back with the next pull.
    expect(store.unsent()).toMatchObject([{ type: 'setProfile', uiLocale: 'en' }])
  })

  test('before the first sync goes on the page, and waits for the row', async () => {
    const store = await member(null)
    expect(chooseLocale(store, 'zh-Hans')).toBe('zh-Hans')
    expect(store.unsent()).toMatchObject([{ type: 'setProfile', uiLocale: 'zh-Hans' }])
    await store.applyPull(pull(5, { profile: [{ ...profile, uiLocale: 'en' }] }, true), store.epoch)
    expect(held(store)?.uiLocale).toBe('zh-Hans')
  })
})

describe('the language chosen on this browser', () => {
  test('is the cookie, among the others', () => {
    expect(chosenLocale('tela_locale=fr')).toBe('fr')
    expect(chosenLocale('a=1; tela_locale=zh-Hant; b=2')).toBe('zh-Hant')
    expect(chosenLocale('tela_locale=zh%2DHans')).toBe('zh-Hans')
  })

  test('is none without one, for one this build does not have, or one that does not decode', () => {
    expect(chosenLocale('')).toBeNull()
    expect(chosenLocale('other_tela_locale=fr')).toBeNull()
    expect(chosenLocale('tela_locale=ja')).toBeNull()
    expect(chosenLocale('tela_locale=%')).toBeNull()
  })

  test("decides the page's language before the browser's own", () => {
    expect(detectLocale('tela_locale=fr', ['zh-TW', 'en'])).toBe('fr')
    expect(detectLocale('tela_locale=%', ['zh-TW', 'en'])).toBe('zh-Hant')
    expect(detectLocale('', [])).toBe('en')
  })
})

describe('the language an address fixes (ADR 0060)', () => {
  /** A page as the app boots on it: its cookie, address and browser languages. */
  function onPage(page: { cookie?: string; search?: string; languages?: string[] }) {
    const saved = ['document', 'window', 'navigator'].map(
      (name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const,
    )
    const set = (name: string, value: unknown) =>
      Object.defineProperty(globalThis, name, { value, configurable: true, writable: true })
    set('document', { cookie: page.cookie ?? '' })
    set('window', { location: { search: page.search ?? '' } })
    set('navigator', { languages: page.languages ?? ['en-US'], language: 'en-US' })
    return () => {
      for (const [name, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor)
        else Reflect.deleteProperty(globalThis, name)
      }
    }
  }

  test('reads ?hl= in any spelling, and nothing else from the address', () => {
    expect(pinnedLocale('?hl=fr')).toBe('fr')
    expect(pinnedLocale('?topic=x&hl=ZH-hans')).toBe('zh-Hans')
    expect(pinnedLocale(new URLSearchParams('hl=zh-TW'))).toBe('zh-Hant')
    expect(pinnedLocale('?hl=de')).toBeNull()
    expect(pinnedLocale('?lang=fr')).toBeNull()
    expect(pinnedLocale('')).toBeNull()
  })

  test("comes before the cookie and the browser's languages, when it is passed", () => {
    expect(detectLocale('tela_locale=zh-Hans', ['en'], 'fr')).toBe('fr')
    expect(detectLocale('tela_locale=zh-Hans', ['en'], null)).toBe('zh-Hans')
  })

  test("at the edge, is a visitor's to fix and never a member's", () => {
    const at = (search: string, headers: Record<string, string>) =>
      requestLocale(new Request(`http://tela.test/discover${search}`, { headers }))
    const chosen = { cookie: 'tela_locale=zh-Hans', 'accept-language': 'en-US' }
    expect(at('?hl=fr', chosen)).toBe('fr')
    expect(at('?hl=FR', { 'accept-language': 'zh-CN' })).toBe('fr')
    expect(at('?hl=de', chosen)).toBe('zh-Hans')
    expect(at('', { 'accept-language': 'zh-TW' })).toBe('zh-Hant')
    // A session cookie, prefixed or not: the member's language, followed by their cookie.
    for (const session of ['tela.session_token=a.b', '__Secure-tela.session_token=a.b']) {
      expect(at('?hl=fr', { ...chosen, cookie: `${chosen.cookie}; ${session}` })).toBe('zh-Hans')
      expect(at('?hl=fr', { cookie: session, 'accept-language': 'en' })).toBe('en')
    }
  })

  test('as the app boots, is what the edge rendered, else the same order with the device for the cookie', () => {
    const restore = onPage({ cookie: 'tela_locale=zh-Hans', search: '?hl=fr', languages: ['en'] })
    try {
      // The edge rendered the page: its language, whatever the device would have chosen.
      expect(bootLocale(false, 'zh-Hant')).toBe('zh-Hant')
      expect(bootLocale(true, 'fr')).toBe('fr')
      // The plain shell (no language of a page): a device with no account takes the address's.
      expect(bootLocale(false, null)).toBe('fr')
      expect(bootLocale(false, 'x-unknown')).toBe('fr')
      // One that holds an account takes the cookie, which follows the account.
      expect(bootLocale(true, null)).toBe('zh-Hans')
    } finally {
      restore()
    }
  })
})

describe('the language posts are read in', () => {
  /** What `useReadingLang` makes of the store's view, as the page renders it. */
  const reading = (store: LocalStore, uiLocale: string) =>
    readingLangOf(store.getSnapshot().tables.profile, uiLocale)

  test("is a visitor's interface language", async () => {
    expect(reading(await visitor(), 'zh-Hant')).toBe('zh-Hant')
  })

  test("is the member's choice, else the account's interface, before the page's", async () => {
    expect(reading(await member({ readingLang: 'fr', uiLocale: 'en' }), 'en')).toBe('fr')
    // The page takes the account's interface language a render after the row lands; the titles
    // the device keeps must not follow the cookie's for that moment.
    expect(reading(await member({ uiLocale: 'zh-Hans' }), 'en')).toBe('zh-Hans')
    expect(reading(await member({}), 'fr')).toBe('fr')
  })

  test('counts a choice still on its way to the server', async () => {
    const store = await member({ uiLocale: 'en', readingLangAt: NOW - 1000 })
    store.mutate({ type: 'setProfile', readingLang: 'zh-Hant' })
    expect(store.unsent()).toHaveLength(1)
    expect(reading(store, 'en')).toBe('zh-Hant')
  })
})

describe('what an account takes from the browser', () => {
  test("its visitor's choice, while the account has none", () => {
    expect(localeToAdopt({ uiLocale: null }, 'tela_locale=fr')).toBe('fr')
  })

  test("nothing over the account's own, whatever it says", () => {
    for (const uiLocale of ['en', 'fr', 'zh-Hans', 'ja']) {
      expect(localeToAdopt({ uiLocale }, 'tela_locale=zh-Hant')).toBeNull()
    }
  })

  // The browser's languages are no choice: an account without one follows them already, on each
  // browser its own, and writing them down would carry one browser's to every other.
  test('nothing without a choice made here', () => {
    expect(localeToAdopt({ uiLocale: null }, '')).toBeNull()
    expect(localeToAdopt({ uiLocale: null }, 'tela_locale=%')).toBeNull()
  })

  test('nothing before the profile is here to say what the account holds', () => {
    expect(localeToAdopt(null, 'tela_locale=fr')).toBeNull()
  })
})

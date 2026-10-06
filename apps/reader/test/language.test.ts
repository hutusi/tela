/** The header's language circle (ADR 0040): what it shows, and what a choice changes. */
import { describe, expect, test } from 'bun:test'
import { READING_LANGUAGES } from '@tela/shared'
import type { ProfileRow } from '@tela/sync'
import { chooseLocale } from '../src/i18n'
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

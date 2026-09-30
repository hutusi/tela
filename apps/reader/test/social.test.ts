/** The reader's pieces for people and prefs (ADR 0031): pure functions of the tables and a clock. */
import { describe, expect, test } from 'bun:test'
import { applyPull, emptyTables, type Tables, view } from '@tela/sync'
import { monthYear, personColor, shortDate } from '../src/lib/format'
import { PREF_KEYS, readingPrefsOf } from '../src/lib/prefs'
import { followedPeople } from '../src/store/selectors'
import { pull } from './rows'

function tables(rows: Parameters<typeof pull>[1]): Tables {
  return view(applyPull({ cursor: 0, tables: emptyTables() }, pull(1, rows, true)), [])
}

describe('the people the member follows', () => {
  test('are named by the pull, or by the page a follow was made from, alphabetically', () => {
    const held = tables({
      follows: [
        {
          userId: 'id-zoe-00001',
          handle: 'zoe',
          displayName: null,
          createdAt: 1,
          deletedAt: null,
          seq: 1,
        },
        {
          userId: 'id-anna-0001',
          handle: 'anna',
          displayName: 'Anna',
          createdAt: 2,
          deletedAt: null,
          seq: 1,
        },
      ],
    })
    const predicted = view({ cursor: 1, tables: held }, [
      { mutation: { mid: 'follow-bo-pad', at: 3, type: 'follow', userId: 'id-bo-000001' } },
      { mutation: { mid: 'follow-x-pad0', at: 3, type: 'follow', userId: 'id-unknown01' } },
    ])
    const page = new Map([
      ['id-bo-000001', { id: 'id-bo-000001', handle: 'bo_b', displayName: 'Bo' }],
    ])
    // Someone followed from nowhere this visit knows is left out until the pull names them.
    expect(followedPeople(predicted, (id) => page.get(id)).map((p) => p.handle)).toEqual([
      'anna',
      'bo_b',
      'zoe',
    ])
  })
})

describe('reading prefs', () => {
  test('default when unset or not understood, and keep a never list as stored', () => {
    expect(readingPrefsOf(tables({}))).toEqual({
      mode: 'side',
      markOnOpen: true,
      hideRead: false,
      autoTranslate: true,
      never: [],
    })
    const pref = (key: string, value: unknown) => ({ key, value, updatedAt: 1, seq: 1 })
    const never = ['ja', 'zh-Hant']
    const set = readingPrefsOf(
      tables({
        prefs: [
          pref(PREF_KEYS.markOnOpen, false),
          pref(PREF_KEYS.hideRead, 'yes'), // not a boolean: the default
          pref(PREF_KEYS.mode, 'trans'),
          pref(PREF_KEYS.never, never),
        ],
      }),
    )
    expect(set).toMatchObject({ markOnOpen: false, hideRead: false, mode: 'trans' })
    expect(set.never).toBe(never) // the stored array itself, so memos keyed on it hold
  })
})

describe('dates and colours for people', () => {
  // Local noon, so the test reads the same in any zone the suite runs in.
  const noon = new Date(2026, 8, 30, 12).getTime()
  const DAY = 86_400_000
  test('a date column says today, yesterday, a day this year, or one with its year', () => {
    expect(shortDate(noon - 60_000, 'en', noon)).toBe('Today')
    expect(shortDate(noon - DAY, 'en', noon)).toBe('Yesterday')
    expect(shortDate(noon - 3 * DAY, 'en', noon)).toBe('Sep 27')
    expect(shortDate(new Date(2025, 11, 31, 12).getTime(), 'en', noon)).toBe('Dec 31, 2025')
    expect(shortDate(noon - DAY, 'zh-Hans', noon)).toBe('昨天')
    expect(monthYear(noon, 'en')).toBe('September 2026')
  })

  test("a person's colour is theirs on every page", () => {
    expect(personColor('anna')).toBe(personColor('anna'))
    expect(personColor('anna')).not.toBe(personColor('bo_b'))
    expect(personColor('anna')).toMatch(/^oklch\(0\.55 0\.11 \d+(\.\d)?\)$/)
  })
})

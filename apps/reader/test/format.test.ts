import { afterEach, describe, expect, test } from 'bun:test'
import { monthYear, relativeTime, shortDate } from '../src/lib/format'

const HOUR = 3_600_000
const DAY = 24 * HOUR
// Noon, local time, so a day either side stays on the same calendar side whatever the zone.
const NOW = new Date(2026, 8, 27, 12).getTime()

describe('dates as lists show them', () => {
  test('relative times, in each interface language', () => {
    expect(relativeTime(NOW - 2 * HOUR, 'en', NOW)).toBe('2h ago')
    expect(relativeTime(NOW - 2 * HOUR, 'zh-Hans', NOW)).toBe('2小时前')
    // French spaces are no-break ones.
    expect(relativeTime(NOW - 2 * HOUR, 'fr', NOW).replace(/\s/g, ' ')).toBe('il y a 2 h')
    expect(relativeTime(NOW - 3 * DAY, 'en', NOW)).toBe('3d ago')
    expect(relativeTime(null, 'en', NOW)).toBe('')
    expect(relativeTime(NOW - 60 * DAY, 'en', NOW)).toBe('Jul 29, 2026')
  })

  test('short dates: today, yesterday, this year, another year', () => {
    expect(shortDate(NOW, 'en', NOW)).toBe('Today')
    expect(shortDate(NOW - DAY, 'en', NOW)).toBe('Yesterday')
    expect(shortDate(NOW - DAY, 'fr', NOW)).toBe('Hier')
    expect(shortDate(NOW - 5 * DAY, 'en', NOW)).toBe('Sep 22')
    expect(shortDate(new Date(2025, 0, 3, 12).getTime(), 'en', NOW)).toBe('Jan 3, 2025')
    expect(monthYear(NOW, 'en')).toBe('September 2026')
  })
})

describe('formatters', () => {
  const { RelativeTimeFormat, DateTimeFormat } = Intl
  // The constructors are read-only in the types, not at run time.
  const intl = Intl as { -readonly [K in keyof typeof Intl]: (typeof Intl)[K] }
  afterEach(() => {
    intl.RelativeTimeFormat = RelativeTimeFormat
    intl.DateTimeFormat = DateTimeFormat
  })

  test('are built once per locale and use, not once per row', () => {
    const built: string[] = []
    intl.RelativeTimeFormat = class extends RelativeTimeFormat {
      constructor(...args: ConstructorParameters<typeof RelativeTimeFormat>) {
        super(...args)
        built.push(`relative ${String(args[0])}`)
      }
    } as typeof RelativeTimeFormat
    intl.DateTimeFormat = class extends DateTimeFormat {
      constructor(...args: ConstructorParameters<typeof DateTimeFormat>) {
        super(...args)
        built.push(`date ${String(args[0])}`)
      }
    } as unknown as typeof DateTimeFormat
    // A locale no other test formats in, so nothing is cached for it yet.
    for (let row = 0; row < 50; row++) {
      relativeTime(NOW - row * HOUR, 'en-GB', NOW)
      shortDate(NOW - row * DAY, 'en-GB', NOW)
      shortDate(new Date(2025, 0, row + 1, 12).getTime(), 'en-GB', NOW)
    }
    expect(built.filter((b) => b.startsWith('relative')).length).toBe(2) // narrow and long
    expect(built.filter((b) => b.startsWith('date')).length).toBe(2) // with the year and without
  })
})

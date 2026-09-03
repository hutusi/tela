import { describe, expect, test } from 'bun:test'
import {
  backoffSec,
  baseIntervalSec,
  cacheControlMaxAge,
  MAX_INTERVAL_SEC,
  MIN_INTERVAL_SEC,
  nextIntervalSec,
  parseRetryAfter,
  withJitter,
} from '../src/schedule'

describe('schedule', () => {
  test('base interval follows posting cadence within bounds', () => {
    expect(baseIntervalSec(0)).toBe(MAX_INTERVAL_SEC)
    expect(baseIntervalSec(1)).toBe(MAX_INTERVAL_SEC)
    expect(baseIntervalSec(7)).toBe(12 * 3600)
    expect(baseIntervalSec(1000)).toBe(MIN_INTERVAL_SEC)
  })

  test('new items reset to base, unchanged fetches back off by 1.5x', () => {
    expect(nextIntervalSec({ currentSec: 3600, itemsLast7d: 7, hadNewItems: true })).toBe(12 * 3600)
    expect(nextIntervalSec({ currentSec: 3600, itemsLast7d: 7, hadNewItems: false })).toBe(5400)
    expect(nextIntervalSec({ currentSec: 20 * 3600, itemsLast7d: 7, hadNewItems: false })).toBe(
      MAX_INTERVAL_SEC,
    )
  })

  test('publisher floors raise the interval', () => {
    expect(
      nextIntervalSec({ currentSec: 3600, itemsLast7d: 50, hadNewItems: true, floorSec: 7200 }),
    ).toBe(7200)
  })

  test('jitter stays within ten percent', () => {
    expect(withJitter(1000, () => 0)).toBe(900)
    expect(withJitter(1000, () => 1)).toBe(1100)
  })

  test('backoff doubles and caps at a week', () => {
    expect(backoffSec(3600, 1)).toBe(7200)
    expect(backoffSec(3600, 3)).toBe(28800)
    expect(backoffSec(3600, 12)).toBe(7 * 24 * 3600)
  })

  test('parses Retry-After in both forms', () => {
    const now = new Date('2026-09-04T00:00:00Z')
    expect(parseRetryAfter('120', now)).toBe(120)
    expect(parseRetryAfter('Fri, 04 Sep 2026 00:05:00 GMT', now)).toBe(300)
    expect(parseRetryAfter('nonsense', now)).toBeNull()
    expect(parseRetryAfter(null, now)).toBeNull()
  })

  test('reads max-age', () => {
    expect(cacheControlMaxAge('public, max-age=600')).toBe(600)
    expect(cacheControlMaxAge('no-cache')).toBeNull()
  })
})

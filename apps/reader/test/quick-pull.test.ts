import { afterEach, beforeEach, describe, expect, jest, test } from 'bun:test'
import {
  QUICK_PULL_FIRST_MS,
  QUICK_PULL_FOR_MS,
  startQuickPull,
  type Visibility,
} from '../src/lib/use-quick-pull'

/** A page whose visibility the test turns, as `visibilitychange` would. */
function page(hidden = false) {
  let isHidden = hidden
  const watchers = new Set<() => void>()
  const visibility: Visibility = {
    hidden: () => isHidden,
    watch: (onChange) => {
      watchers.add(onChange)
      return () => void watchers.delete(onChange)
    },
  }
  const set = (next: boolean) => {
    isHidden = next
    for (const w of watchers) w()
  }
  return { visibility, set, watching: () => watchers.size }
}

/** When each pull came, in ms after the start. */
function recorder() {
  const started = Date.now()
  const at: number[] = []
  return { pull: () => void at.push(Date.now() - started), at }
}

describe('quick pulls', () => {
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => jest.useRealTimers())

  test('back off from 4 s to a minute, and stop two minutes in', () => {
    const { visibility, watching } = page()
    const { pull, at } = recorder()
    startQuickPull(pull, visibility)
    jest.advanceTimersByTime(10 * 60_000)
    expect(at).toEqual([4000, 12_000, 28_000, 60_000, 120_000])
    expect(at.every((t) => t <= QUICK_PULL_FOR_MS)).toBe(true)
    // Done, it no longer listens for the page coming into view.
    expect(watching()).toBe(0)
  })

  test('none is made while the tab is hidden, and they go on once it is shown', () => {
    const tab = page()
    const { pull, at } = recorder()
    startQuickPull(pull, tab.visibility)
    jest.advanceTimersByTime(QUICK_PULL_FIRST_MS)
    expect(at).toEqual([4000])
    tab.set(true)
    jest.advanceTimersByTime(30_000)
    expect(at).toEqual([4000])
    // Shown at 34 s: the next waits its own 8 s from there.
    tab.set(false)
    jest.advanceTimersByTime(8000)
    expect(at).toEqual([4000, 42_000])
  })

  test('hidden at the start, the first waits until the tab is shown', () => {
    const tab = page(true)
    const { pull, at } = recorder()
    startQuickPull(pull, tab.visibility)
    jest.advanceTimersByTime(60_000)
    expect(at).toEqual([])
    tab.set(false)
    jest.advanceTimersByTime(QUICK_PULL_FIRST_MS)
    expect(at).toEqual([64_000])
  })

  test('a tab hidden past the two minutes makes no more when shown', () => {
    const tab = page()
    const { pull, at } = recorder()
    startQuickPull(pull, tab.visibility)
    jest.advanceTimersByTime(QUICK_PULL_FIRST_MS)
    tab.set(true)
    jest.advanceTimersByTime(QUICK_PULL_FOR_MS)
    tab.set(false)
    jest.advanceTimersByTime(10 * 60_000)
    expect(at).toEqual([4000])
    expect(tab.watching()).toBe(0)
  })

  test('stopping ends the pulls and the listening', () => {
    const tab = page()
    const { pull, at } = recorder()
    const stop = startQuickPull(pull, tab.visibility)
    jest.advanceTimersByTime(QUICK_PULL_FIRST_MS)
    stop()
    stop()
    jest.advanceTimersByTime(10 * 60_000)
    expect(at).toEqual([4000])
    expect(tab.watching()).toBe(0)
  })
})

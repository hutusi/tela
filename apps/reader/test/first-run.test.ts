import { describe, expect, test } from 'bun:test'
import { showsFirstRun } from '../src/components/first-run'

const base = { synced: true, subscriptions: 0, open: false, filter: 'all', latched: false }

describe('showsFirstRun', () => {
  test('a member who follows nothing sees it, once their rows are here', () => {
    expect(showsFirstRun(base)).toBe(true)
    expect(showsFirstRun({ ...base, filter: 'today' })).toBe(true)
    expect(showsFirstRun({ ...base, synced: false })).toBe(false)
    expect(showsFirstRun({ ...base, subscriptions: 2 })).toBe(false)
  })

  test('it stays up through subscribing, until the member starts reading', () => {
    expect(showsFirstRun({ ...base, subscriptions: 2, latched: true })).toBe(true)
  })

  test('never over an open article, nor in place of what the member liked', () => {
    expect(showsFirstRun({ ...base, open: true })).toBe(false)
    expect(showsFirstRun({ ...base, filter: 'liked' })).toBe(false)
    expect(showsFirstRun({ ...base, filter: 'liked', latched: true })).toBe(false)
  })
})

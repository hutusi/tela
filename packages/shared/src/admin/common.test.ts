import { describe, expect, test } from 'bun:test'
import { isAdminFilter, isLedgerArea } from './common'

describe("the console's areas", () => {
  test('are only the ledgers, never what every object has', () => {
    expect(isLedgerArea('claims')).toBe(true)
    // `/admin/constructor` once took Object for an area and unmounted the app.
    for (const name of ['overview', 'constructor', '__proto__', 'toString', 'valueOf', 7]) {
      expect(isLedgerArea(name)).toBe(false)
    }
    expect(isAdminFilter('feeds', 'fetching')).toBe(true)
    expect(isAdminFilter('feeds', 'review')).toBe(false)
  })
})

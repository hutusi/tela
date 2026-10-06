import { describe, expect, test } from 'bun:test'
import {
  ACTION_WRITES,
  actionsWriting,
  isAdminFilter,
  isLedgerArea,
  UNDOABLE_ACTIONS,
} from './common'

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

describe('what actions write', () => {
  test('every undoable action writes something a later one can stand in the way of', () => {
    for (const action of UNDOABLE_ACTIONS) {
      const writes = ACTION_WRITES[action]
      expect({ action, writes }).toEqual({ action, writes: expect.any(String) })
      expect(actionsWriting(writes ?? '')).toContain(action)
    }
    expect(actionsWriting('listing').sort()).toEqual([
      'site.feature',
      'site.hide',
      'site.list',
      'site.restore',
    ])
  })
})

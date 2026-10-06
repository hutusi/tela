import { describe, expect, test } from 'bun:test'
import {
  ADMIN_FILTERS,
  actionsCrossing,
  actionsWriting,
  isAdminFilter,
  isLedgerArea,
  UNDOABLE_ACTIONS,
  writesOf,
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

  test('Discover opens on its review queue (ADR 0041)', () => {
    expect(ADMIN_FILTERS.discover[0]).toBe('candidates')
  })
})

describe('what actions write', () => {
  test('every undoable action writes something a later one can stand in the way of', () => {
    for (const action of UNDOABLE_ACTIONS) {
      expect({ action, writes: writesOf(action).length > 0 }).toEqual({ action, writes: true })
      for (const what of writesOf(action)) expect(actionsWriting(what)).toContain(action)
      expect(actionsCrossing(action)).toContain(action)
    }
    expect(writesOf('site.fetchAll')).toEqual([])
  })

  test('a dismissal is no listing chosen since, and a List still stands in its way (ADR 0041)', () => {
    // What a removed claim's undo asks about: the listings chosen since, never a dismissal.
    expect(actionsWriting('listing').sort()).toEqual([
      'site.feature',
      'site.hide',
      'site.list',
      'site.restore',
    ])
    expect(actionsCrossing('site.dismiss').sort()).toEqual([
      'site.dismiss',
      'site.feature',
      'site.hide',
      'site.list',
    ])
    expect(actionsCrossing('site.list')).toContain('site.dismiss')
    expect(actionsCrossing('site.restore')).not.toContain('site.dismiss')
  })
})

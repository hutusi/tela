import { describe, expect, test } from 'bun:test'
import {
  ACTION_INPUT,
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

  test('Discover opens on its review queue (ADR 0041), and lists blogrolls last (ADR 0050)', () => {
    expect(ADMIN_FILTERS.discover[0]).toBe('candidates')
    expect(ADMIN_FILTERS.discover.at(-1)).toBe('blogrolls')
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

  test('a blogroll’s Hide and Restore stand in each other’s way, and nothing else does', () => {
    expect(UNDOABLE_ACTIONS).toContain('blogroll.hide')
    expect(UNDOABLE_ACTIONS).toContain('blogroll.restore')
    expect(actionsCrossing('blogroll.hide').sort()).toEqual(['blogroll.hide', 'blogroll.restore'])
    expect(actionsCrossing('blogroll.restore').sort()).toEqual([
      'blogroll.hide',
      'blogroll.restore',
    ])
  })
})

describe('an app’s actions (ADR 0064)', () => {
  test('approve, cut off and restore stand in each other’s way; an edit only in its own', () => {
    expect(actionsCrossing('app.suspend').sort()).toEqual([
      'app.approve',
      'app.restore',
      'app.suspend',
    ])
    // An edit and a review both write the email permission: a later one stands in the way.
    expect(actionsCrossing('app.edit').sort()).toEqual(['app.edit', 'app.review'])
    // A feed's pause writes its own status, never an app's.
    expect(actionsCrossing('feed.pause')).not.toContain('app.suspend')
  })

  test('ending the connections is one-shot: nothing gives a member’s grant back', () => {
    expect(UNDOABLE_ACTIONS).not.toContain('app.endConnections' as never)
    expect(writesOf('app.endConnections')).toEqual([])
  })

  test('a review and its dismissal answer one request, and the area opens on the queue (ADR 0067)', () => {
    expect(ADMIN_FILTERS.apps[0]).toBe('review')
    expect(UNDOABLE_ACTIONS).toContain('app.review')
    expect(UNDOABLE_ACTIONS).toContain('app.dismissReview')
    expect(actionsCrossing('app.review').sort()).toEqual([
      'app.dismissReview',
      'app.edit',
      'app.review',
    ])
    expect(actionsCrossing('app.dismissReview').sort()).toEqual(['app.dismissReview', 'app.review'])
    // A blog's review for Discover is another thing altogether.
    expect(actionsCrossing('app.review')).not.toContain('site.dismiss')
    // Its own input, never the address `email` asks for.
    expect(ACTION_INPUT['app.review']).toBe('review')
  })
})

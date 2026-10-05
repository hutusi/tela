/**
 * The admin console's ledger state (ADR 0039): what the address holds, how a sort orders rows, and
 * where the selection goes after an action.
 */
import { describe, expect, test } from 'bun:test'
import {
  auditedRow,
  compareSort,
  ledgerHref,
  nextAfterAct,
  nextSort,
  parseLedgerState,
  patchedHref,
  sortRows,
  sortValueOf,
} from '../src/admin/state'
import { BLOGS, blogSpec } from './admin-fixtures'

const parse = (area: Parameters<typeof parseLedgerState>[0], query: string) =>
  parseLedgerState(area, new URLSearchParams(query))

describe('the address', () => {
  test('a plain address is the first filter, nothing searched, open or sorted', () => {
    expect(parse('claims', '')).toEqual({
      filter: 'review',
      q: '',
      id: null,
      sort: null,
      dir: 'asc',
    })
  })

  test('reads every part it holds', () => {
    expect(parse('feeds', 'f=dead&q=nordvest&id=88&sort=c2&dir=desc')).toEqual({
      filter: 'dead',
      q: 'nordvest',
      id: '88',
      sort: 'c2',
      dir: 'desc',
    })
  })

  test('what is not this area’s state reads as unset', () => {
    // Another area's filter, an unknown sort, a direction without a sort, an empty id.
    expect(parse('feeds', 'f=review&sort=readers&dir=desc&id=')).toEqual({
      filter: 'failing',
      q: '',
      id: null,
      sort: null,
      dir: 'asc',
    })
    expect(parse('people', 'sort=name&dir=sideways').dir).toBe('asc')
    expect(parse('system', `id=${'x'.repeat(400)}`).id).toBeNull()
    expect(parse('sites', `q=${'y'.repeat(500)}`).q).toHaveLength(200)
  })

  test('writes only what differs from the defaults', () => {
    expect(ledgerHref('claims')).toBe('/admin/claims')
    expect(ledgerHref('claims', { filter: 'review', q: '', id: null, sort: null })).toBe(
      '/admin/claims',
    )
    expect(ledgerHref('claims', { filter: 'verified', id: '41' })).toBe(
      '/admin/claims?f=verified&id=41',
    )
    expect(ledgerHref('feeds', { sort: 'status', dir: 'desc', q: 'a b' })).toBe(
      '/admin/feeds?q=a+b&sort=status&dir=desc',
    )
    // A direction means nothing without a sort.
    expect(ledgerHref('feeds', { dir: 'desc' })).toBe('/admin/feeds')
  })

  test('round-trips', () => {
    const state = parse('invites', 'f=revoked&q=WRITERS&id=code%3AWRITERS&sort=c1&dir=desc')
    const href = ledgerHref('invites', state)
    expect(parse('invites', href.slice(href.indexOf('?') + 1))).toEqual(state)
  })

  test('a change applies to the address as it is now', () => {
    expect(patchedHref('feeds', '?f=dead&q=x&sort=c1', { id: '9' })).toBe(
      '/admin/feeds?f=dead&q=x&id=9&sort=c1',
    )
    expect(patchedHref('feeds', '?f=dead&id=9', { id: null })).toBe('/admin/feeds?f=dead')
  })

  test('an audit entry opens the row its ledger lists, whatever the audit log keys it by', () => {
    expect(auditedRow('site', '12')).toEqual({ area: 'sites', id: '12' })
    expect(auditedRow('feed', '88')).toEqual({ area: 'feeds', id: '88' })
    expect(auditedRow('claim', '41')).toEqual({ area: 'claims', id: '41' })
    expect(auditedRow('member', 'u-mara')).toEqual({ area: 'people', id: 'u-mara' })
    // The ledgers with two kinds of row tell them apart by a prefix the audit log does not keep.
    expect(auditedRow('dead', '5')).toEqual({ area: 'system', id: 'dead:5' })
    expect(auditedRow('lease', 'translate.body:9:zh-Hans')).toEqual({
      area: 'system',
      id: 'lease:translate.body:9:zh-Hans',
    })
    expect(auditedRow('code', 'WRITERS')).toEqual({ area: 'invites', id: 'code:WRITERS' })
    expect(auditedRow('hold', '17')).toEqual({ area: 'invites', id: 'hold:17' })
    expect(auditedRow('report', '1')).toBeNull()
  })

  test('a header click cycles ascending, descending, off', () => {
    let sort = nextSort({ sort: null, dir: 'asc' }, 'c1')
    expect(sort).toEqual({ sort: 'c1', dir: 'asc' })
    sort = nextSort(sort, 'c1')
    expect(sort).toEqual({ sort: 'c1', dir: 'desc' })
    expect(nextSort(sort, 'c1')).toEqual({ sort: null, dir: 'asc' })
    // Another column starts over.
    expect(nextSort(sort, 'name')).toEqual({ sort: 'name', dir: 'asc' })
  })
})

describe('sorting', () => {
  test('numbers by size, words as a person reads them', () => {
    expect(compareSort(2, 10, 'asc')).toBeLessThan(0)
    expect(compareSort(2, 10, 'desc')).toBeGreaterThan(0)
    expect(compareSort('feed 9', 'feed 10', 'asc')).toBeLessThan(0)
    expect(compareSort('apple', 'Banana', 'asc')).toBeLessThan(0)
    expect(compareSort('same', 'Same', 'asc')).toBe(0)
  })

  test('a missing value goes last whichever way the column runs', () => {
    for (const dir of ['asc', 'desc'] as const) {
      expect(compareSort(null, 3, dir)).toBeGreaterThan(0)
      expect(compareSort('', 'a', dir)).toBeGreaterThan(0)
      expect(compareSort('—', 'a', dir)).toBeGreaterThan(0)
      expect(compareSort(5, null, dir)).toBeLessThan(0)
      expect(compareSort(null, null, dir)).toBe(0)
    }
    const values = [3, null, 10, 1]
    expect(sortRows(values, (v) => v, 'asc')).toEqual([1, 3, 10, null])
    expect(sortRows(values, (v) => v, 'desc')).toEqual([10, 3, 1, null])
  })

  test('ties keep the order the server sent', () => {
    const rows = [
      { id: 'a', n: 1 },
      { id: 'b', n: 0 },
      { id: 'c', n: 1 },
    ]
    expect(sortRows(rows, (r) => r.n, 'desc').map((r) => r.id)).toEqual(['a', 'c', 'b'])
  })

  test('a column sorts by its number where it has one, else by its words', () => {
    const spec = blogSpec()
    const by = (key: Parameters<typeof sortValueOf>[1], dir: 'asc' | 'desc' = 'asc') =>
      sortRows(BLOGS, sortValueOf(spec, key), dir).map((row) => row.title)
    expect(by('c1', 'desc')).toEqual(['Nordvest', 'Pfadwerk', '日々の海'])
    // No language is a dash, and goes last.
    expect(by('c2')).toEqual(['Pfadwerk', '日々の海', 'Nordvest'])
    expect(by('c2', 'desc')).toEqual(['日々の海', 'Pfadwerk', 'Nordvest'])
    expect(by('name')).toEqual(['Nordvest', 'Pfadwerk', '日々の海'])
    // By the status's words; the two Failing rows keep the server's order.
    expect(by('status')).toEqual(['Nordvest', '日々の海', 'Pfadwerk'])
  })
})

describe('after an action', () => {
  const before = ['a', 'b', 'c', 'd']

  test('stays on a row still listed', () => {
    expect(nextAfterAct(before, ['a', 'b', 'c', 'd'], 'b')).toBe('b')
  })

  test('moves to the next row when it left', () => {
    expect(nextAfterAct(before, ['a', 'c', 'd'], 'b')).toBe('c')
    // The next one left too (a bulk action, or someone else's): the one after it.
    expect(nextAfterAct(before, ['a', 'd'], 'b')).toBe('d')
  })

  test('the last row moves back to the one before it', () => {
    expect(nextAfterAct(before, ['a', 'b', 'c'], 'd')).toBe('c')
  })

  test('nothing left, nothing to move to', () => {
    expect(nextAfterAct(['a'], [], 'a')).toBeNull()
  })

  test('only new rows: the first of them', () => {
    expect(nextAfterAct(['a'], ['x', 'y'], 'a')).toBe('x')
  })

  test('a row the list never showed has no place to move on from', () => {
    expect(nextAfterAct(before, ['a', 'b'], 'zz')).toBeNull()
  })
})

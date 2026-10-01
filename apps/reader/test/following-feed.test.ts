/** The Following feed's held pages (ADR 0031): refreshed and extended without gaps or repeats. */
import { describe, expect, test } from 'bun:test'
import { appendPage, mergeFirstPage } from '../src/lib/following-feed'

const e = (at: number, key = `r:${String(at).padStart(12, '0')}`, note = '') => ({ at, key, note })
const keys = (p: { items: { key: string }[] }) => p.items.map((i) => i.key)

describe('a fresh first page over the pages held', () => {
  const held = { items: [e(90), e(80), e(70), e(60), e(50)], next: '50:r:000000000050' }

  test('replaces the entries it repeats, with what they say now, and keeps the older pages', () => {
    const fresh = { items: [e(90, undefined, 'edited'), e(80), e(70)], next: '70:r:000000000070' }
    const merged = mergeFirstPage(held, fresh)
    expect(keys(merged)).toEqual(keys(held))
    expect(merged.items[0]?.note).toBe('edited')
    expect(merged.next).toBe(held.next)
  })

  test('puts what is new on top, and keeps the older pages where they carry on', () => {
    const fresh = { items: [e(95), e(90), e(80)], next: '80:r:000000000080' }
    expect(keys(mergeFirstPage(held, fresh))).toEqual(keys({ items: [e(95), ...held.items] }))
  })

  test('keeps only the fresh page when it no longer reaches what is held, or is all there is', () => {
    const far = { items: [e(130), e(120), e(110)], next: '110:r:000000000110' }
    expect(mergeFirstPage(held, far)).toEqual(far)
    const all = { items: [e(90), e(80)], next: null }
    expect(mergeFirstPage(held, all)).toEqual(all) // the rest is gone from the server
    const none = { items: [], next: null }
    expect(mergeFirstPage(held, none)).toEqual(none)
  })

  test('keeps only the fresh page when an entry it held in that range moved down or went', () => {
    // A day's likes held at 80: an unlike moved the group to 55, among the held older pages, which
    // were fetched before and so do not have it there. Keeping them would hide it for the visit.
    const liked = { items: [e(90), e(80, 'l:anna:20000'), e(70), e(60), e(50)], next: '50:x' }
    const fresh = { items: [e(90), e(70)], next: '70:r:000000000070' }
    expect(mergeFirstPage(liked, fresh)).toEqual(fresh)
  })
})

describe('an older page after the ones held', () => {
  test('leaves out an entry already held: a day group moved past the cursor', () => {
    const held = { items: [e(90), e(80, 'l:anna:20000')], next: '80:l:anna:20000' }
    const page = { items: [e(75, 'l:anna:20000'), e(70)], next: null }
    expect(keys(appendPage(held, page))).toEqual([
      'r:000000000090',
      'l:anna:20000',
      'r:000000000070',
    ])
  })
})

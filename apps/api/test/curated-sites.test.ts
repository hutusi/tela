import { describe, expect, test } from 'bun:test'
import { siteKeyOf } from '@tela/shared'
import { CURATED_SITES, type CuratedSite } from '../scripts/curated-sites'

const list = CURATED_SITES as readonly CuratedSite[]

describe('the curated list', () => {
  test('names each feed once', () => {
    const urls = list.map((s) => s.feedUrl)
    expect(urls.filter((u, i) => urls.indexOf(u) !== i)).toEqual([])
  })

  test('names a home only as the blog Tela keys it by (ADR 0069)', () => {
    // A home curate moves a feed to must be the key every fetch and Add resolve too, or the next
    // feed of that blog would land elsewhere.
    const homes = list.flatMap((s) => (s.home ? [s.home] : []))
    expect(homes.length).toBeGreaterThan(0)
    for (const home of homes) expect(siteKeyOf(home)).toBe(home)
  })
})

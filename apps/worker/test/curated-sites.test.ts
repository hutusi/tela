import { describe, expect, test } from 'bun:test'
import { isTopic } from '@tela/shared'
import { CURATED_SITES } from '../src/seed/curated-sites'

/**
 * The list is editorial content, so these guard the mechanical parts a reviewer should not have
 * to check by eye. Nothing here reaches the network: a feed that stops resolving shows up in a
 * seed run's report, not in a unit test.
 */
describe('CURATED_SITES', () => {
  test('is a real directory, not a stub someone truncated', () => {
    expect(CURATED_SITES.length).toBeGreaterThanOrEqual(20)
  })

  test('every feed URL is absolute, https, and already normalized', () => {
    for (const site of CURATED_SITES) {
      const feedUrl: string = site.feedUrl
      const url = new URL(feedUrl)
      expect(url.protocol).toBe('https:')
      expect(feedUrl).toBe(url.toString())
    }
  })

  test('no duplicate feed, and no two entries on one origin', () => {
    const urls = CURATED_SITES.map((s) => s.feedUrl)
    expect(new Set(urls).size).toBe(urls.length)
    // Two entries on one origin would curate the same site twice with conflicting topics: the
    // second call wins and the first entry's topics vanish without a word.
    const origins = CURATED_SITES.map((s) => new URL(s.feedUrl).origin)
    expect(new Set(origins).size).toBe(origins.length)
  })

  // Non-empty is a type guarantee (CuratedSite.topics is a non-empty tuple); validity and
  // repetition are not, and a repeated slug would be silently deduped on the way into the row.
  test('topics are valid slugs, not repeated within an entry', () => {
    for (const { feedUrl, topics } of CURATED_SITES) {
      for (const topic of topics) {
        expect({ feedUrl, topic, ok: isTopic(topic) }).toEqual({ feedUrl, topic, ok: true })
      }
      expect(new Set(topics).size).toBe(topics.length)
    }
  })

  test('covers every topic chip, because /discover renders all nine either way', () => {
    const covered = new Set(CURATED_SITES.flatMap((s) => s.topics))
    expect([...covered].sort()).toEqual([
      'cities',
      'design',
      'essays',
      'food',
      'life',
      'outdoors',
      'photography',
      'science',
      'tech',
    ])
  })
})

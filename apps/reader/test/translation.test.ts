import { describe, expect, test } from 'bun:test'
import { type BlockPair, translatedPrefix } from '../src/lib/block-pairs'
import { type Live, moreAdvanced } from '../src/lib/use-translation'

const at = (state: string, chunks: number): Live => ({
  state,
  chunkKeys: Array.from({ length: chunks }, (_, i) => `tc/k/en/r/${i}.json`),
  objectKey: null,
  failedLeaves: [],
})

describe('what an open article shows of its translation', () => {
  test('a later state wins, whichever side it comes from', () => {
    expect(moreAdvanced(at('requested', 0), at('running', 1))?.state).toBe('running')
    expect(moreAdvanced(at('done', 4), at('running', 3))?.state).toBe('done')
    expect(moreAdvanced(undefined, at('running', 1))?.state).toBe('running')
  })

  test('while both run, the chunks polling has seen are not held back by the last pull', () => {
    // A pull a minute ago said running with two chunks; polling now sees five.
    expect(moreAdvanced(at('running', 2), at('running', 5))?.chunkKeys).toHaveLength(5)
    expect(moreAdvanced(at('running', 5), at('running', 2))?.chunkKeys).toHaveLength(5)
  })

  test('between two finished answers, the synced row stands', () => {
    expect(moreAdvanced(at('done', 3), at('partial', 4))?.state).toBe('done')
  })
})

describe('what Translation mode shows of a translation still arriving', () => {
  const pair = (id: string, pending = false): BlockPair => ({
    id,
    tag: 'p',
    translated: pending ? `<p>${id}</p>` : `<p>en: ${id}</p>`,
    original: `<p>${id}</p>`,
    untranslated: pending,
    pending,
  })

  test('the blocks before the first one still on its way, and a placeholder for the rest', () => {
    const pairs = [pair('a'), pair('b'), pair('c', true), pair('d', true)]
    const shown = translatedPrefix(pairs, 'running')
    expect(shown.pairs.map((p) => p.id)).toEqual(['a', 'b'])
    expect(shown.rest).toBe(true)
  })

  test('a block after a gap waits for the gap, so nothing reads as following on from it', () => {
    // The third chunk landed before the second, whose fetch failed or is still out.
    const pairs = [pair('a'), pair('b', true), pair('c'), pair('d')]
    const shown = translatedPrefix(pairs, 'done')
    expect(shown.pairs.map((p) => p.id)).toEqual(['a'])
    expect(shown.rest).toBe(true)
  })

  test('nothing more comes once it failed: what never came shows as not translated', () => {
    const pairs = [pair('a'), pair('b', true), pair('c')]
    const shown = translatedPrefix(pairs, 'failed')
    expect(shown.rest).toBe(false)
    expect(shown.pairs.map((p) => [p.id, p.untranslated, p.pending])).toEqual([
      ['a', false, false],
      ['b', true, false],
      ['c', false, false],
    ])
  })

  test('with nothing pending, the pairs are shown as they are', () => {
    const pairs = [pair('a'), { ...pair('b'), untranslated: true }]
    for (const state of ['done', 'partial', 'failed', 'running'] as const) {
      const shown = translatedPrefix(pairs, state)
      expect(shown.pairs).toBe(pairs)
      expect(shown.rest).toBe(false)
    }
  })
})

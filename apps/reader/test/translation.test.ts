import { describe, expect, test } from 'bun:test'
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

import { describe, expect, test } from 'bun:test'
import type { ReaderBlock } from '@/components/reader-data'
import { pairBlocks } from './block-pairs'

const block = (id: string, tag: string, html: string): ReaderBlock => ({ id, tag, html })

describe('pairBlocks', () => {
  test('zips two matching bodies, one row per block', () => {
    const pairs = pairBlocks(
      [block('a', 'p', '<p>一</p>'), block('b', 'h2', '<h2>二</h2>')],
      [block('a', 'p', '<p>One</p>'), block('b', 'h2', '<h2>Two</h2>')],
    )
    expect(pairs).toEqual([
      { id: 'a', tag: 'p', translated: '<p>一</p>', original: '<p>One</p>' },
      { id: 'b', tag: 'h2', translated: '<h2>二</h2>', original: '<h2>Two</h2>' },
    ])
  })

  test('falls back to one whole-body row when the lengths differ', () => {
    const pairs = pairBlocks(
      [block('a', 'p', '<p>一</p>')],
      [block('a', 'p', '<p>One</p>'), block('b', 'p', '<p>Two</p>')],
    )
    expect(pairs).toEqual([
      { id: 'whole', tag: null, translated: '<p>一</p>', original: '<p>One</p><p>Two</p>' },
    ])
  })

  test('falls back when an id disagrees, rather than pairing the wrong blocks', () => {
    const pairs = pairBlocks(
      [block('a', 'p', '<p>一</p>'), block('b', 'p', '<p>二</p>')],
      [block('a', 'p', '<p>One</p>'), block('c', 'p', '<p>Two</p>')],
    )
    expect(pairs).toHaveLength(1)
    expect(pairs[0]?.tag).toBeNull()
  })

  test('falls back when a tag disagrees', () => {
    const pairs = pairBlocks(
      [block('a', 'p', '<p>一</p>')],
      [block('a', 'blockquote', '<blockquote>One</blockquote>')],
    )
    expect(pairs).toHaveLength(1)
    expect(pairs[0]?.tag).toBeNull()
  })

  test('two empty bodies pair to nothing at all', () => {
    expect(pairBlocks([], [])).toEqual([])
  })
})

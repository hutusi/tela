import { describe, expect, test } from 'bun:test'
import type { ArticleBlock } from '@tela/content'
import type { ReaderBlock } from '@/components/reader-data'
import { blocksContaining, pairBlocks, runsOf } from './block-pairs'

const block = (id: string, tag: string, html: string): ReaderBlock => ({ id, tag, html })

describe('pairBlocks', () => {
  test('zips two matching bodies, one row per block', () => {
    const pairs = pairBlocks(
      [block('a', 'p', '<p>一</p>'), block('b', 'h2', '<h2>二</h2>')],
      [block('a', 'p', '<p>One</p>'), block('b', 'h2', '<h2>Two</h2>')],
    )
    expect(pairs).toEqual([
      { id: 'a', tag: 'p', translated: '<p>一</p>', original: '<p>One</p>', untranslated: false },
      {
        id: 'b',
        tag: 'h2',
        translated: '<h2>二</h2>',
        original: '<h2>Two</h2>',
        untranslated: false,
      },
    ])
  })

  test('falls back to one whole-body row when the lengths differ', () => {
    const pairs = pairBlocks(
      [block('a', 'p', '<p>一</p>')],
      [block('a', 'p', '<p>One</p>'), block('b', 'p', '<p>Two</p>')],
    )
    expect(pairs).toEqual([
      {
        id: 'whole',
        tag: null,
        translated: '<p>一</p>',
        original: '<p>One</p><p>Two</p>',
        untranslated: false,
      },
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

  test('marks the blocks whose translation fell back to source text', () => {
    const pairs = pairBlocks(
      [block('a', 'p', '<p>一</p>'), block('b', 'p', '<p>Two</p>')],
      [block('a', 'p', '<p>One</p>'), block('b', 'p', '<p>Two</p>')],
      ['b'],
    )
    expect(pairs.map((p) => p.untranslated)).toEqual([false, true])
  })

  test('two empty bodies pair to nothing at all', () => {
    expect(pairBlocks([], [])).toEqual([])
  })
})

describe('blocksContaining', () => {
  const b = (id: string, ...ids: string[]): ArticleBlock => ({
    html: '',
    tag: 'p',
    ids: [id, ...ids],
  })

  test('names the top-level block a failed leaf sits in, not the leaf', () => {
    // A failed <li> marks its whole list: the list is what the reader can point at.
    const list: ArticleBlock = { html: '', tag: 'ul', ids: ['l1', 'l2', 'l3'] }
    expect(blocksContaining([b('p1'), list, b('p2')], ['l2'])).toEqual(['l1'])
  })

  test('no failures names no blocks', () => {
    expect(blocksContaining([b('p1'), b('p2')], [])).toEqual([])
  })

  test('a failure in no block at all names nothing rather than guessing', () => {
    expect(blocksContaining([b('p1')], ['gone'])).toEqual([])
  })

  test('falls back to the position for a block that carries no ids', () => {
    const rule: ArticleBlock = { html: '<hr>', tag: 'hr', ids: [] }
    expect(blocksContaining([rule, b('p1')], ['p1'])).toEqual(['p1'])
  })
})

describe('runsOf', () => {
  const b = (id: string, html: string) => block(id, 'p', html)

  test('a fully translated body stays one run, as it always rendered', () => {
    expect(runsOf([b('a', '<p>一</p>'), b('b', '<p>二</p>')])).toEqual([
      { id: 'a', html: '<p>一</p><p>二</p>', untranslated: false },
    ])
  })

  test('splits only around the blocks that failed', () => {
    const runs = runsOf([b('a', '<p>一</p>'), b('b', '<p>Two</p>'), b('c', '<p>三</p>')], ['b'])
    expect(runs).toEqual([
      { id: 'a', html: '<p>一</p>', untranslated: false },
      { id: 'b', html: '<p>Two</p>', untranslated: true },
      { id: 'c', html: '<p>三</p>', untranslated: false },
    ])
  })

  test('adjacent failures share one run, so the label is said once', () => {
    const runs = runsOf(
      [b('a', '<p>One</p>'), b('b', '<p>Two</p>'), b('c', '<p>三</p>')],
      ['a', 'b'],
    )
    expect(runs.map((r) => r.untranslated)).toEqual([true, false])
    expect(runs[0]?.html).toBe('<p>One</p><p>Two</p>')
  })

  test('no blocks is no runs, which is what the empty body renders from', () => {
    expect(runsOf([])).toEqual([])
  })
})

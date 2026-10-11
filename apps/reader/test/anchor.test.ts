import { describe, expect, test } from 'bun:test'
import { HIGHLIGHT_NOTE_MAX, HIGHLIGHT_QUOTE_MAX } from '@tela/shared'
import { anchorChanged, anchorIn, mergeAnchors, resolveAnchor, type Span } from '../src/lib/anchor'

const leaves = (...pairs: [string, string][]) => new Map(pairs)

describe('finding a highlight again', () => {
  const text = 'The quick brown fox jumps over the lazy dog. The dog sleeps.'
  const anchor = anchorIn('leaf-a', text, 4, 15) // "quick brown"

  test('keeps the quote and up to 32 characters of context either side', () => {
    expect(anchor).toEqual({
      leafId: 'leaf-a',
      start: 4,
      end: 15,
      quote: 'quick brown',
      prefix: 'The ',
      suffix: ' fox jumps over the lazy dog. Th',
    })
  })

  test('an unchanged leaf holds it where it was', () => {
    expect(resolveAnchor(anchor, leaves(['leaf-a', text]))).toEqual({
      status: 'exact',
      leafId: 'leaf-a',
      start: 4,
      end: 15,
    })
  })

  test('an edit earlier in the same paragraph moves it along', () => {
    const edited = `Update: ${text}`
    const found = resolveAnchor(anchor, leaves(['leaf-a', edited]))
    expect(found).toEqual({ status: 'moved', leafId: 'leaf-a', start: 12, end: 23 })
    expect(anchorChanged(anchor, found)).toBe(true)
  })

  test('a paragraph whose id changed (its text did) is found by quote and context', () => {
    const found = resolveAnchor(
      anchor,
      leaves(['leaf-x', 'An intro that was added.'], ['leaf-b', `${text} (edited)`]),
    )
    expect(found).toEqual({ status: 'moved', leafId: 'leaf-b', start: 4, end: 15 })
  })

  test('context decides between two occurrences', () => {
    const dog = anchorIn('leaf-a', text, text.lastIndexOf('dog'), text.lastIndexOf('dog') + 3)
    const moved = resolveAnchor(dog, leaves(['leaf-b', `Intro. ${text}`]))
    expect(moved).toMatchObject({ status: 'moved', start: `Intro. ${text}`.lastIndexOf('dog') })
  })

  test('the same id with different text is re-checked, not trusted', () => {
    // A repeated block's id carries its position; after an edit `leaf-a-2` can name another block.
    const repeated = anchorIn('leaf-a-2', 'Second copy of a line.', 0, 6)
    expect(resolveAnchor(repeated, leaves(['leaf-a-2', 'Something else entirely.']))).toEqual({
      status: 'detached',
    })
  })

  test('a passage the post no longer has is detached', () => {
    expect(resolveAnchor(anchor, leaves(['leaf-a', 'All new words.']))).toEqual({
      status: 'detached',
    })
  })

  test('a short quote with nothing else to go on is detached rather than guessed', () => {
    const the = anchorIn('leaf-a', 'and the end', 4, 7)
    const post = leaves(['leaf-b', 'the first'], ['leaf-c', 'then the second'])
    expect(resolveAnchor(the, post)).toEqual({ status: 'detached' })
    // One occurrence is not a guess.
    expect(resolveAnchor(the, leaves(['leaf-b', 'only the one']))).toMatchObject({
      status: 'moved',
    })
  })

  test('works on Chinese text as on any other', () => {
    const zh = '今天天气很好，我们去公园散步。'
    const a = anchorIn('leaf-zh', zh, 7, 12) // 我们去公园
    expect(resolveAnchor(a, leaves(['leaf-new', `早上好。${zh}`]))).toEqual({
      status: 'moved',
      leafId: 'leaf-new',
      start: 11,
      end: 16,
    })
  })
})

describe('a highlight over others takes them in', () => {
  const text = 'The quick brown fox jumps over the lazy dog. The dog sleeps.'
  /** A highlight already in the leaf over `quote`, the first time it occurs. */
  const span = (id: string, quote: string, note: string | null = null): Span => {
    const start = text.indexOf(quote)
    return { id, start, end: start + quote.length, note }
  }
  const sel = (quote: string) => ({
    start: text.indexOf(quote),
    end: text.indexOf(quote) + quote.length,
  })

  test('one it overlaps: the union, with the context of the union', () => {
    const merged = mergeAnchors('leaf-a', text, sel('brown fox'), [span('h1', 'quick brown', 'Q')])
    expect(merged).toEqual({
      kind: 'merge',
      anchor: anchorIn('leaf-a', text, 4, 19),
      absorbed: ['h1'],
      note: 'Q',
    })
    expect(merged?.kind === 'merge' && merged.anchor.quote).toBe('quick brown fox')
  })

  test('one it touches counts; one a space away does not', () => {
    // "quick" ends where " brown" would start: selecting "brown" leaves a space between them.
    expect(mergeAnchors('leaf-a', text, sel('brown'), [span('h1', 'quick')])).toBeNull()
    const touching = mergeAnchors('leaf-a', text, sel(' brown'), [span('h1', 'quick')])
    expect(touching).toMatchObject({ kind: 'merge', absorbed: ['h1'] })
    expect(touching?.kind === 'merge' && touching.anchor.quote).toBe('quick brown')
  })

  test('a union keeps reaching until nothing more joins, in whatever order they are given', () => {
    // "brown fox" reaches "fox jumps", which then touches " over the".
    const chain = [span('far', ' over the', 'C'), span('near', 'fox jumps', 'B')]
    for (const existing of [chain, [...chain].reverse()]) {
      const merged = mergeAnchors('leaf-a', text, sel('brown fox'), existing)
      expect(merged).toMatchObject({ kind: 'merge', absorbed: ['near', 'far'], note: 'B\n\nC' })
      expect(merged?.kind === 'merge' && merged.anchor.quote).toBe('brown fox jumps over the')
    }
  })

  test('a selection bridging two takes both in, their notes in reading order, each once', () => {
    const merged = mergeAnchors('leaf-a', text, sel('brown fox jumps'), [
      span('h2', 'jumps over', 'Same.'),
      span('h1', 'quick brown', 'Same.'),
      span('h3', 'fox', null),
      span('h4', 'lazy dog', 'Elsewhere.'),
    ])
    expect(merged).toMatchObject({
      kind: 'merge',
      absorbed: ['h1', 'h3', 'h2'],
      note: 'Same.',
    })
    expect(merged?.kind === 'merge' && merged.anchor.quote).toBe('quick brown fox jumps over')
  })

  test('a selection inside one changes nothing, and names it', () => {
    expect(mergeAnchors('leaf-a', text, sel('brown'), [span('h1', 'quick brown fox')])).toEqual({
      kind: 'inside',
      id: 'h1',
    })
    // Exactly over it is inside it too.
    expect(mergeAnchors('leaf-a', text, sel('fox'), [span('h1', 'fox')])).toEqual({
      kind: 'inside',
      id: 'h1',
    })
  })

  test('none reached, or none there: a highlight of its own', () => {
    expect(mergeAnchors('leaf-a', text, sel('lazy'), [span('h1', 'quick brown')])).toBeNull()
    expect(mergeAnchors('leaf-a', text, sel('lazy'), [])).toBeNull()
  })

  test('works on Chinese text as on any other', () => {
    const zh = '今天天气很好，我们去公园散步。'
    const merged = mergeAnchors('leaf-zh', zh, { start: 7, end: 12 }, [
      { id: 'h1', start: 10, end: 14, note: '公园' },
    ])
    expect(merged).toMatchObject({ kind: 'merge', absorbed: ['h1'], note: '公园' })
    expect(merged?.kind === 'merge' && merged.anchor).toEqual(anchorIn('leaf-zh', zh, 7, 14))
    expect(merged?.kind === 'merge' && merged.anchor.quote).toBe('我们去公园散步')
  })

  test('a union over either limit is refused: the selection is made on its own', () => {
    const long = 'x'.repeat(HIGHLIGHT_QUOTE_MAX + 100)
    const quoteOver = mergeAnchors('leaf-l', long, { start: 1000, end: long.length }, [
      { id: 'h1', start: 0, end: 1100, note: null },
    ])
    expect(quoteOver).toBeNull()
    // At the limit exactly is fine.
    expect(
      mergeAnchors('leaf-l', long, { start: 1000, end: HIGHLIGHT_QUOTE_MAX }, [
        { id: 'h1', start: 0, end: 1100, note: null },
      ]),
    ).toMatchObject({ kind: 'merge' })

    const half = 'n'.repeat(HIGHLIGHT_NOTE_MAX / 2)
    const notesOver = mergeAnchors('leaf-a', text, sel('brown fox jumps'), [
      span('h1', 'quick brown', half),
      span('h2', 'jumps over', `${half}!`),
    ])
    expect(notesOver).toBeNull()
  })
})

import { describe, expect, test } from 'bun:test'
import { anchorChanged, anchorIn, resolveAnchor } from '../src/lib/anchor'

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

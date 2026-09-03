import { describe, expect, test } from 'bun:test'
import { makeExcerpt, readingMinutes, wordCount } from './excerpt'

describe('excerpt', () => {
  test('returns short text untouched', () => {
    expect(makeExcerpt(['Hello  world', '', ' second '])).toBe('Hello world second')
  })

  test('cuts long Latin text at a word boundary with an ellipsis', () => {
    const words = Array.from({ length: 80 }, (_, i) => `word${i}`)
    const joined = words.join(' ')
    const out = makeExcerpt([joined], 100)
    expect(out.length).toBeLessThanOrEqual(101)
    expect(out.endsWith('…')).toBe(true)
    const kept = out.slice(0, -1)
    expect(joined.startsWith(kept)).toBe(true)
    // the cut lands on a word boundary: the next source character is a space
    expect(joined[kept.length]).toBe(' ')
  })

  test('cuts CJK text by character count', () => {
    const out = makeExcerpt(['这是一段很长的中文文本。'.repeat(40)], 50)
    expect(out.length).toBe(51)
    expect(out.endsWith('…')).toBe(true)
  })

  test('counts words and CJK characters', () => {
    expect(wordCount('one two three')).toBe(3)
    expect(wordCount('中文 字符 and words')).toBe(6)
  })

  test('reading minutes has a floor of one', () => {
    expect(readingMinutes('short')).toBe(1)
    expect(readingMinutes('word '.repeat(700))).toBe(3)
    expect(readingMinutes('字'.repeat(1200))).toBe(3)
  })
})

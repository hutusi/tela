import { describe, expect, test } from 'bun:test'
import { learnContentMode } from '../src/content-mode'

const sample = (chars: number, hadFullContent: boolean, tail = 'the end.') => ({
  chars,
  hadFullContent,
  tail,
})

describe('learnContentMode', () => {
  test('needs three samples', () => {
    expect(learnContentMode([sample(100, false), sample(100, false)])).toBe('unknown')
  })

  test('short bodies without a full-content field are summaries', () => {
    expect(learnContentMode([sample(120, false), sample(200, false), sample(90, false)])).toBe(
      'summary',
    )
  })

  test('long bodies are full even without content:encoded', () => {
    expect(learnContentMode([sample(2000, false), sample(3500, false), sample(1800, false)])).toBe(
      'full',
    )
  })

  test('read-more tails mark summaries even with a content field', () => {
    expect(
      learnContentMode([
        sample(900, true, 'Continue reading'),
        sample(950, true, '阅读全文'),
        sample(800, true, 'done'),
      ]),
    ).toBe('summary')
  })

  test('very short bodies are summaries even with a content field', () => {
    expect(learnContentMode([sample(200, true), sample(150, true), sample(250, true)])).toBe(
      'summary',
    )
  })
})

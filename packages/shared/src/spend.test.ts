import { describe, expect, test } from 'bun:test'
import { MAX_ARTICLE_TRANSLATION_TOKENS } from './constants'
import { bodySpendFor, MAX_BODY_SPEND, sourceTokensFor } from './spend'

describe('what a body is reckoned to spend', () => {
  test('counts the output and the prompts, not the source alone', () => {
    expect(bodySpendFor(0)).toBe(0)
    // One small chunk: 2.5 a source token and one prompt.
    expect(bodySpendFor(400)).toBe(2000)
    // 2,000 source tokens: the opening chunk and one full one.
    expect(bodySpendFor(2000)).toBe(7000)
    expect(MAX_BODY_SPEND).toBe(bodySpendFor(MAX_ARTICLE_TRANSLATION_TOKENS))
    expect(MAX_BODY_SPEND).toBe(115_000)
  })

  test('a reservation pays for exactly the source tokens it was made for', () => {
    for (let n = 0; n <= MAX_ARTICLE_TRANSLATION_TOKENS; n += 137) {
      expect(sourceTokensFor(bodySpendFor(n))).toBe(n)
    }
    // Never more than it reckoned, whatever the amount.
    for (const spend of [0, 1, 999, 1000, 3499, 7000, 7001, 50_000, MAX_BODY_SPEND]) {
      expect(bodySpendFor(sourceTokensFor(spend)) <= spend).toBe(true)
      expect(bodySpendFor(sourceTokensFor(spend) + 1) > spend).toBe(true)
    }
  })
})

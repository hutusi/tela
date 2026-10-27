/**
 * What opening a post does before its body is on screen (ADR 0066): a subscribed blog's post asks
 * for its translation as it opens, as always; any other's waits for its body, so one refused for
 * the day's limit is never paid to translate.
 */
import { describe, expect, test } from 'bun:test'
import { asksForTranslation } from '../src/lib/open-post'

describe('asking for a translation as a post opens', () => {
  const base = { wanted: true, subscribed: false, answered: false, refused: false }

  test('a subscribed blog’s post asks at once, before its body has answered', () => {
    expect(asksForTranslation({ ...base, subscribed: true })).toBe(true)
  })

  test('any other’s waits for its body, and a refused one never asks', () => {
    expect(asksForTranslation(base)).toBe(false)
    expect(asksForTranslation({ ...base, answered: true })).toBe(true)
    expect(asksForTranslation({ ...base, answered: true, refused: true })).toBe(false)
    // Subscribed from the refused post: nothing until the body comes.
    expect(asksForTranslation({ ...base, subscribed: true, answered: true, refused: true })).toBe(
      false,
    )
  })

  test('nothing is asked for while translation is not wanted', () => {
    expect(asksForTranslation({ ...base, wanted: false, subscribed: true, answered: true })).toBe(
      false,
    )
  })
})

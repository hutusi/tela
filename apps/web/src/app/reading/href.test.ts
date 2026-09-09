import { describe, expect, test } from 'bun:test'
import { canonicalReadingHref } from './href'

describe('canonicalReadingHref', () => {
  test('drops the defaults that carry no meaning', () => {
    expect(canonicalReadingHref('?article=1&mode=side')).toBe('/reading?article=1')
    expect(canonicalReadingHref('?filter=all')).toBe('/reading')
  })

  test('does not care what order the params arrived in', () => {
    expect(canonicalReadingHref('?article=1&filter=today')).toBe(
      canonicalReadingHref('?filter=today&article=1'),
    )
  })

  test('ignores values that mean nothing', () => {
    expect(canonicalReadingHref('?article=0&feed=-3&mode=sideways&filter=nope')).toBe('/reading')
  })

  test('keeps what does carry meaning', () => {
    expect(canonicalReadingHref('?filter=liked&feed=2&article=7&mode=trans')).toBe(
      '/reading?filter=liked&feed=2&article=7&mode=trans',
    )
  })

  test('applies overrides on top', () => {
    expect(canonicalReadingHref('?article=1', { mode: 'trans' })).toBe(
      '/reading?article=1&mode=trans',
    )
    expect(canonicalReadingHref('?article=1&mode=trans', { mode: 'side' })).toBe(
      '/reading?article=1',
    )
  })
})

/** The header's language circle (ADR 0040): what it shows. */
import { describe, expect, test } from 'bun:test'
import { READING_LANGUAGES } from '@tela/shared'
import { circleLabel, pillLabel } from '../src/lib/format'

describe('the language circle', () => {
  test('shows each language in a character or two, each Chinese in its own script', () => {
    expect(READING_LANGUAGES.map(circleLabel)).toEqual(['简', '繁', 'EN', 'FR'])
  })

  test('fits the circle: one Chinese character, or two Latin letters', () => {
    for (const code of READING_LANGUAGES) {
      const label = circleLabel(code)
      expect(label.length === 1 || /^[A-Z]{2}$/.test(label), `${code}: ${label}`).toBe(true)
    }
  })

  test('falls back to the badge for a language it has no label for', () => {
    expect(circleLabel('ja')).toBe('JA')
  })

  test("leaves the pill's longer labels to the admin console", () => {
    expect(READING_LANGUAGES.map(pillLabel)).toEqual(['简体', '繁體', 'EN', 'FR'])
  })
})

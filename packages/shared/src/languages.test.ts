import { describe, expect, test } from 'bun:test'
import { isReadingLanguage, isUiLocale, languageBadge } from './languages'

describe('languages', () => {
  test('reading languages are the launch set', () => {
    expect(isReadingLanguage('zh-Hans')).toBe(true)
    expect(isReadingLanguage('en')).toBe(true)
    expect(isReadingLanguage('ja')).toBe(false)
    expect(isReadingLanguage(undefined)).toBe(false)
  })

  test('ui locale guard', () => {
    expect(isUiLocale('en')).toBe(true)
    expect(isUiLocale('fr')).toBe(false)
  })

  test('badge labels', () => {
    expect(languageBadge('es')).toBe('ES')
    expect(languageBadge('zh-Hans')).toBe('ZH')
    expect(languageBadge('zh-Hant')).toBe('ZH-TW')
    expect(languageBadge('pt-BR')).toBe('PT')
  })
})

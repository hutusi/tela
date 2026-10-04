import { describe, expect, test } from 'bun:test'
import {
  asLabel,
  isReadingLanguage,
  isUiLocale,
  LANGUAGE_NAMES,
  languageBadge,
  negotiateLocale,
  normalizeLangTag,
  preferredLanguages,
  READING_LANGUAGES,
} from './languages'

describe('languages', () => {
  test('reading languages are the launch set', () => {
    expect(isReadingLanguage('zh-Hans')).toBe(true)
    expect(isReadingLanguage('zh-Hant')).toBe(true)
    expect(isReadingLanguage('en')).toBe(true)
    expect(isReadingLanguage('fr')).toBe(true)
    expect(isReadingLanguage('ja')).toBe(false)
    expect(isReadingLanguage(undefined)).toBe(false)
  })

  test('ui locale guard', () => {
    expect(isUiLocale('en')).toBe(true)
    expect(isUiLocale('zh-Hant')).toBe(true)
    expect(isUiLocale('fr')).toBe(true)
    expect(isUiLocale('ja')).toBe(false)
  })

  test('every reading language names every reading language', () => {
    for (const reader of READING_LANGUAGES) {
      for (const tag of READING_LANGUAGES) expect(LANGUAGE_NAMES[reader][tag]).toBeTruthy()
      expect(Object.keys(LANGUAGE_NAMES[reader]).sort()).toEqual(
        Object.keys(LANGUAGE_NAMES.en).sort(),
      )
    }
  })

  test('a label capitalises a name French writes in lower case', () => {
    expect(asLabel(LANGUAGE_NAMES.fr.fr as string, 'fr')).toBe('Français')
    expect(asLabel(LANGUAGE_NAMES.fr.en as string, 'fr')).toBe('Anglais')
    expect(asLabel('繁體中文', 'zh-Hant')).toBe('繁體中文')
  })

  test('badge labels', () => {
    expect(languageBadge('es')).toBe('ES')
    expect(languageBadge('zh-Hans')).toBe('ZH')
    expect(languageBadge('zh-Hant')).toBe('ZH-TW')
    expect(languageBadge('pt-BR')).toBe('PT')
  })

  test('tags keep the two Chinese scripts apart and drop every other region', () => {
    expect(normalizeLangTag('zh-CN')).toBe('zh-Hans')
    expect(normalizeLangTag('zh')).toBe('zh-Hans')
    expect(normalizeLangTag('zh_TW')).toBe('zh-Hant')
    expect(normalizeLangTag('zh-HK')).toBe('zh-Hant')
    expect(normalizeLangTag('zh-Hant-TW')).toBe('zh-Hant')
    // Some sources separate every subtag with an underscore, not only the first.
    expect(normalizeLangTag('zh_Hant_TW')).toBe('zh-Hant')
    expect(normalizeLangTag('zh_Hans_CN')).toBe('zh-Hans')
    expect(normalizeLangTag('en_US')).toBe('en')
    expect(normalizeLangTag('fr-CA')).toBe('fr')
    expect(normalizeLangTag('en-US')).toBe('en')
    expect(normalizeLangTag('')).toBeNull()
  })

  test('Accept-Language is read in order of preference', () => {
    expect(preferredLanguages('en-US,en;q=0.9,zh-CN;q=0.5')).toEqual(['en-US', 'en', 'zh-CN'])
    expect(preferredLanguages('de;q=0.5, fr-CA, *;q=0.1')).toEqual(['fr-CA', 'de'])
    expect(preferredLanguages('ja;q=0, en')).toEqual(['en'])
    expect(preferredLanguages('')).toEqual([])
  })

  test('the interface language is the first one Tela has', () => {
    const negotiate = (header: string) => negotiateLocale(preferredLanguages(header))
    expect(negotiate('zh-CN,zh;q=0.9')).toBe('zh-Hans')
    expect(negotiate('en-US,en;q=0.9,zh-CN;q=0.5')).toBe('en')
    expect(negotiate('ja,zh-CN;q=0.8')).toBe('zh-Hans')
    expect(negotiate('zh-TW')).toBe('zh-Hant')
    expect(negotiate('zh-HK,zh;q=0.8')).toBe('zh-Hant')
    expect(negotiate('zh-Hant-TW')).toBe('zh-Hant')
    expect(negotiate('fr-CA')).toBe('fr')
    expect(negotiate('de,fr;q=0.8')).toBe('fr')
    expect(negotiate('ja')).toBe('en')
    expect(negotiate('')).toBe('en')
  })
})

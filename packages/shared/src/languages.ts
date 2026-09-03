/**
 * Reading languages the product offers. Translation targets are always drawn
 * from this list; never from "every language a subscriber speaks".
 * BCP-47 tags. Keep in sync with apps/web/messages/*.json for UI locales.
 */
export const READING_LANGUAGES = ['zh-Hans', 'en'] as const
export type ReadingLanguage = (typeof READING_LANGUAGES)[number]

export const UI_LOCALES = ['zh-Hans', 'en'] as const
export type UiLocale = (typeof UI_LOCALES)[number]

export const DEFAULT_UI_LOCALE: UiLocale = 'en'

export function isReadingLanguage(value: unknown): value is ReadingLanguage {
  return typeof value === 'string' && (READING_LANGUAGES as readonly string[]).includes(value)
}

export function isUiLocale(value: unknown): value is UiLocale {
  return typeof value === 'string' && (UI_LOCALES as readonly string[]).includes(value)
}

/** Human-readable names, keyed by the language the *reader* is using. */
export const LANGUAGE_NAMES: Record<UiLocale, Record<string, string>> = {
  en: {
    'zh-Hans': 'Chinese (Simplified)',
    'zh-Hant': 'Chinese (Traditional)',
    en: 'English',
    ja: 'Japanese',
    ko: 'Korean',
    es: 'Spanish',
    pt: 'Portuguese',
    fr: 'French',
    de: 'German',
    it: 'Italian',
    ru: 'Russian',
    nl: 'Dutch',
    sv: 'Swedish',
    no: 'Norwegian',
    da: 'Danish',
    fi: 'Finnish',
    pl: 'Polish',
    tr: 'Turkish',
    ar: 'Arabic',
    vi: 'Vietnamese',
    id: 'Indonesian',
    th: 'Thai',
  },
  'zh-Hans': {
    'zh-Hans': '简体中文',
    'zh-Hant': '繁體中文',
    en: '英语',
    ja: '日语',
    ko: '韩语',
    es: '西班牙语',
    pt: '葡萄牙语',
    fr: '法语',
    de: '德语',
    it: '意大利语',
    ru: '俄语',
    nl: '荷兰语',
    sv: '瑞典语',
    no: '挪威语',
    da: '丹麦语',
    fi: '芬兰语',
    pl: '波兰语',
    tr: '土耳其语',
    ar: '阿拉伯语',
    vi: '越南语',
    id: '印尼语',
    th: '泰语',
  },
}

/** Short badge label, e.g. "ES → EN" in the article list. */
export function languageBadge(tag: string): string {
  const primary = tag.split('-')[0] ?? tag
  if (tag === 'zh-Hans') return 'ZH'
  if (tag === 'zh-Hant') return 'ZH-TW'
  return primary.toUpperCase()
}

/**
 * Reading languages the product offers. Translation targets are always drawn from this list;
 * never from "every language a subscriber speaks" (ADR 0006). BCP-47 tags. The model writes
 * Simplified Chinese only; Traditional is converted from it (ADR 0038).
 */
export const READING_LANGUAGES = ['zh-Hans', 'zh-Hant', 'en', 'fr'] as const
export type ReadingLanguage = (typeof READING_LANGUAGES)[number]

/**
 * Interface languages, one catalog each in apps/reader/messages. Every one is also a reading
 * language: a visitor reads in the language of the interface (the edge passes one as the other),
 * so the two lists must not drift apart.
 */
export const UI_LOCALES = ['zh-Hans', 'en'] as const satisfies readonly ReadingLanguage[]
export type UiLocale = (typeof UI_LOCALES)[number]

export const DEFAULT_UI_LOCALE: UiLocale = 'en'

export function isReadingLanguage(value: unknown): value is ReadingLanguage {
  return typeof value === 'string' && (READING_LANGUAGES as readonly string[]).includes(value)
}

export function isUiLocale(value: unknown): value is UiLocale {
  return typeof value === 'string' && (UI_LOCALES as readonly string[]).includes(value)
}

/**
 * Map a declared, detected or requested tag onto the tags Tela uses. `zh-Hans` and `zh-Hant` are
 * different languages here and are kept apart; every other tag collapses to its primary subtag,
 * so a stored tag is never regional.
 */
export function normalizeLangTag(tag: string | null | undefined): string | null {
  if (!tag) return null
  const t = tag.trim().toLowerCase().replace('_', '-')
  if (!t) return null
  if (t === 'zh' || t === 'zh-cn' || t === 'zh-sg' || t === 'zh-hans' || t.startsWith('zh-hans-')) {
    return 'zh-Hans'
  }
  if (
    t === 'zh-tw' ||
    t === 'zh-hk' ||
    t === 'zh-mo' ||
    t === 'zh-hant' ||
    t.startsWith('zh-hant-')
  ) {
    return 'zh-Hant'
  }
  return t.split('-')[0] ?? null
}

/** An Accept-Language header's tags, most preferred first; `q=0` and `*` say nothing. */
export function preferredLanguages(header: string): string[] {
  return header
    .split(',')
    .map((part, index) => {
      const [tag = '', ...params] = part.split(';').map((p) => p.trim())
      const q = params.find((p) => p.startsWith('q='))
      const weight = q === undefined ? 1 : Number(q.slice(2))
      return { tag, weight: Number.isFinite(weight) ? weight : 0, index }
    })
    .filter((l) => l.tag !== '' && l.tag !== '*' && l.weight > 0)
    .sort((a, b) => b.weight - a.weight || a.index - b.index)
    .map((l) => l.tag)
}

/**
 * The interface language for a browser's languages, most preferred first: the first one Tela
 * has, else English. `zh-TW` and `zh-HK` read Traditional, and a preferred English is not beaten
 * by a Chinese listed after it.
 */
export function negotiateLocale(languages: readonly string[]): UiLocale {
  for (const language of languages) {
    const tag = normalizeLangTag(language)
    if (isUiLocale(tag)) return tag
  }
  return DEFAULT_UI_LOCALE
}

/**
 * Human-readable names, keyed by the language the *reader* is using. French writes a language's
 * name in lower case mid-sentence ("traduit du japonais"); a label capitalises it.
 */
export const LANGUAGE_NAMES: Record<ReadingLanguage, Record<string, string>> = {
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
  'zh-Hant': {
    'zh-Hans': '簡體中文',
    'zh-Hant': '繁體中文',
    en: '英文',
    ja: '日文',
    ko: '韓文',
    es: '西班牙文',
    pt: '葡萄牙文',
    fr: '法文',
    de: '德文',
    it: '義大利文',
    ru: '俄文',
    nl: '荷蘭文',
    sv: '瑞典文',
    no: '挪威文',
    da: '丹麥文',
    fi: '芬蘭文',
    pl: '波蘭文',
    tr: '土耳其文',
    ar: '阿拉伯文',
    vi: '越南文',
    id: '印尼文',
    th: '泰文',
  },
  fr: {
    'zh-Hans': 'chinois simplifié',
    'zh-Hant': 'chinois traditionnel',
    en: 'anglais',
    ja: 'japonais',
    ko: 'coréen',
    es: 'espagnol',
    pt: 'portugais',
    fr: 'français',
    de: 'allemand',
    it: 'italien',
    ru: 'russe',
    nl: 'néerlandais',
    sv: 'suédois',
    no: 'norvégien',
    da: 'danois',
    fi: 'finnois',
    pl: 'polonais',
    tr: 'turc',
    ar: 'arabe',
    vi: 'vietnamien',
    id: 'indonésien',
    th: 'thaï',
  },
}

/**
 * A name as a label starts it: French writes "français" mid-sentence and "Français" in a menu.
 * Scripts without case pass through.
 */
export function asLabel(name: string, locale: string): string {
  return name.charAt(0).toLocaleUpperCase(locale) + name.slice(1)
}

/** Short badge label, e.g. "ES → EN" in the article list. */
export function languageBadge(tag: string): string {
  const primary = tag.split('-')[0] ?? tag
  if (tag === 'zh-Hans') return 'ZH'
  if (tag === 'zh-Hant') return 'ZH-TW'
  return primary.toUpperCase()
}

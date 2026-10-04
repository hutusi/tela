/**
 * A language's name, as the front page's titles toggle and cards label it: in the language itself
 * while titles are as written ("Español"), and in the reader's language while they are translated
 * ("Spanish"). `Intl.DisplayNames` knows far more languages than Tela's own list; that list is the
 * fallback where a runtime's ICU does not, and the tag itself is the last resort.
 *
 * Both are labels, so both start with a capital: French writes "espagnol" mid-sentence, as
 * `LANGUAGE_NAMES.fr` holds it, and "Espagnol" on a button (`asLabel`).
 */
import { asLabel, LANGUAGE_NAMES, type UiLocale } from '@tela/shared'

function displayName(tag: string, inLocale: string): string | null {
  try {
    const name = new Intl.DisplayNames([inLocale], { type: 'language', fallback: 'none' }).of(tag)
    return name || null
  } catch {
    return null
  }
}

/** The language's name in itself: `es` is "Español", `zh-Hant` "繁體中文". */
export function nativeName(tag: string): string {
  const own = displayName(tag, tag)
  if (own) return asLabel(own, tag)
  return LANGUAGE_NAMES.en[tag] ?? tag
}

/** The language's name in the reader's interface language: `es` is "Spanish", or in French "Espagnol". */
export function nameIn(tag: string, locale: string): string {
  const name = LANGUAGE_NAMES[locale as UiLocale]?.[tag] ?? displayName(tag, locale)
  return name ? asLabel(name, locale) : tag
}

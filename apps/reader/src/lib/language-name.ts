/**
 * A language's name, as the front page's titles toggle shows it: in the language itself while
 * titles are as written ("Español"), and in the reader's language while they are translated
 * ("Spanish"). `Intl.DisplayNames` knows far more languages than Tela's own list; that list is the
 * fallback where a runtime's ICU does not, and the tag itself is the last resort.
 */
import { LANGUAGE_NAMES, type UiLocale } from '@tela/shared'

function displayName(tag: string, inLocale: string): string | null {
  try {
    const name = new Intl.DisplayNames([inLocale], { type: 'language', fallback: 'none' }).of(tag)
    return name || null
  } catch {
    return null
  }
}

/** A name as a label starts: "Français", not "français". */
function capitalised(name: string, locale: string): string {
  const [first = ''] = name
  return first.toLocaleUpperCase(locale) + name.slice(first.length)
}

/** The language's name in itself: `es` is "Español", `zh-Hant` "繁體中文". */
export function nativeName(tag: string): string {
  const own = displayName(tag, tag)
  if (own) return capitalised(own, tag)
  return LANGUAGE_NAMES.en[tag] ?? tag
}

/** The language's name in the reader's interface language: `es` in English is "Spanish". */
export function nameIn(tag: string, locale: string): string {
  const listed = LANGUAGE_NAMES[locale as UiLocale]?.[tag]
  if (listed) return listed
  const named = displayName(tag, locale)
  return named ? capitalised(named, locale) : tag
}

import { isReadingLanguage, type ReadingLanguage } from '@tela/shared'

/** Where the browser remembers the reading language. See `getReadingLang`. */
export const READING_LANG_COOKIE = 'tela_reading_lang'

export const READING_LANG_COOKIE_OPTIONS = {
  path: '/',
  maxAge: 365 * 24 * 3600,
  sameSite: 'lax',
} as const

/**
 * The reading language is a profile setting, but reading it from `profiles` costs a database
 * round trip before the reading page can even start its queries — the language decides which
 * translations to join. Mirroring it into a cookie removes that dependency, the way the UI locale
 * already works (`LOCALE_COOKIE`).
 *
 * The member id is part of the value so a cookie left by whoever used this browser last is
 * ignored rather than applied to someone else's session. The profile row stays the source of
 * truth: this is a cache, and a miss simply costs the query it was avoiding.
 */
export function readingLangCookie(userId: string, lang: ReadingLanguage): string {
  return `${userId}:${lang}`
}

/** The language a cookie holds for this member, or null when it holds nothing usable. */
export function readingLangFromCookie(
  value: string | undefined,
  userId: string,
): ReadingLanguage | null {
  if (!value) return null
  const at = value.indexOf(':')
  if (at < 0 || value.slice(0, at) !== userId) return null
  const lang = value.slice(at + 1)
  return isReadingLanguage(lang) ? lang : null
}

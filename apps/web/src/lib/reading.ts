import { isReadingLanguage, type ReadingLanguage } from '@tela/shared'
import { cookies } from 'next/headers'
import { getLocale } from 'next-intl/server'
import { cache } from 'react'
import { getSessionUser } from './auth'
import { getCurrentProfile } from './profile'
import { READING_LANG_COOKIE, readingLangFromCookie } from './reading-lang-cookie'

/**
 * The language articles are translated into: the profile setting for signed-in members,
 * otherwise the UI locale (the two sets coincide at launch).
 *
 * The cookie is read first because this value gates the reading page's queries — it decides
 * which translations to join — so reading it from `profiles` puts a database round trip in front
 * of everything else. `setReadingLang` and the sign-in callback keep the cookie in step; when it
 * is missing the profile row answers, deduplicated with the header's own lookup.
 */
export const getReadingLang = cache(async (): Promise<ReadingLanguage> => {
  const locale = await getLocale()
  const fallback: ReadingLanguage = isReadingLanguage(locale) ? locale : 'en'
  const user = await getSessionUser()
  if (!user) return fallback
  const store = await cookies()
  const fromCookie = readingLangFromCookie(store.get(READING_LANG_COOKIE)?.value, user.id)
  if (fromCookie) return fromCookie
  const profile = await getCurrentProfile()
  return profile && isReadingLanguage(profile.readingLang) ? profile.readingLang : fallback
})

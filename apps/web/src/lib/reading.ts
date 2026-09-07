import { isReadingLanguage, type ReadingLanguage } from '@tela/shared'
import { cookies } from 'next/headers'
import { getLocale } from 'next-intl/server'
import { cache } from 'react'
import { getSessionUser } from './auth'
import { getCurrentProfile } from './profile'
import { READING_LANG_COOKIE, readingLangFromCookie } from './reading-lang-cookie'

export type ReadingLangState = {
  lang: ReadingLanguage
  /** Present only when a successful profile lookup should repair a missing browser cache. */
  seed: { userId: string; lang: ReadingLanguage } | null
}

/**
 * The language articles are translated into: the profile setting for signed-in members,
 * otherwise the UI locale (the two sets coincide at launch).
 *
 * The cookie is read first because this value gates the reading page's queries — it decides
 * which translations to join — so reading it from `profiles` puts a database round trip in front
 * of everything else. The setting action and every sign-in path keep the cookie in step. When it
 * is missing, a successful profile lookup answers once and lets the header repair the cache after
 * hydration; a failed lookup is never cached as the locale fallback.
 */
export const getReadingLangState = cache(async (): Promise<ReadingLangState> => {
  const locale = await getLocale()
  const fallback: ReadingLanguage = isReadingLanguage(locale) ? locale : 'en'
  const user = await getSessionUser()
  if (!user) return { lang: fallback, seed: null }
  const store = await cookies()
  const fromCookie = readingLangFromCookie(store.get(READING_LANG_COOKIE)?.value, user.id)
  if (fromCookie) return { lang: fromCookie, seed: null }
  const profile = await getCurrentProfile()
  if (!profile || !isReadingLanguage(profile.readingLang)) {
    return { lang: fallback, seed: null }
  }
  return {
    lang: profile.readingLang,
    seed: { userId: user.id, lang: profile.readingLang },
  }
})

export const getReadingLang = cache(async (): Promise<ReadingLanguage> => {
  return (await getReadingLangState()).lang
})

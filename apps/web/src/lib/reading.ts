import { getProfile } from '@tela/db/queries'
import { isReadingLanguage, type ReadingLanguage } from '@tela/shared'
import { getLocale } from 'next-intl/server'
import { cache } from 'react'
import { getSessionUser } from './auth'
import { getDb } from './platform/db'

/**
 * The language articles are translated into: the profile setting for signed-in users,
 * otherwise the UI locale (the two sets coincide at launch).
 */
export const getReadingLang = cache(async (): Promise<ReadingLanguage> => {
  const locale = await getLocale()
  const fallback: ReadingLanguage = isReadingLanguage(locale) ? locale : 'en'
  const user = await getSessionUser()
  if (!user) return fallback
  try {
    const profile = await getProfile(await getDb(), user.id)
    return profile && isReadingLanguage(profile.readingLang) ? profile.readingLang : fallback
  } catch {
    return fallback
  }
})

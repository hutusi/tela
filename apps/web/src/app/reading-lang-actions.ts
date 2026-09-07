'use server'

import { setReadingLang as persist } from '@tela/db/queries'
import { isReadingLanguage } from '@tela/shared'
import { revalidatePath } from 'next/cache'
import { cookies } from 'next/headers'
import { requireUser } from '@/lib/auth'
import { getDb } from '@/lib/platform/db'
import {
  READING_LANG_COOKIE,
  READING_LANG_COOKIE_OPTIONS,
  readingLangCookie,
} from '@/lib/reading-lang-cookie'

export async function setReadingLang(form: FormData): Promise<void> {
  const lang = form.get('lang')
  if (!isReadingLanguage(lang)) return
  const user = await requireUser()
  await persist(await getDb(), user.id, lang)
  // The profile row is the source of truth; the cookie is what saves every later render a round
  // trip to read it back (see `getReadingLang`).
  const store = await cookies()
  store.set(READING_LANG_COOKIE, readingLangCookie(user.id, lang), READING_LANG_COOKIE_OPTIONS)
  revalidatePath('/', 'layout')
}

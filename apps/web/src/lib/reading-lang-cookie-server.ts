import { getProfile } from '@tela/db/queries'
import { isReadingLanguage } from '@tela/shared'
import { getDb } from './platform/db'
import {
  READING_LANG_COOKIE,
  READING_LANG_COOKIE_OPTIONS,
  readingLangCookie,
} from './reading-lang-cookie'

type CookieSetter = (
  name: typeof READING_LANG_COOKIE,
  value: string,
  options: typeof READING_LANG_COOKIE_OPTIONS,
) => unknown

type SeedDeps = {
  readReadingLang?: (userId: string) => Promise<unknown>
  warn?: (message: string, context: { err: string }) => void
}

async function profileReadingLang(userId: string): Promise<unknown> {
  return (await getProfile(await getDb(), userId))?.readingLang
}

/** Best-effort cache seed for an authentication response; a failure must not block sign-in. */
export async function seedReadingLangCookie(
  userId: string,
  setCookie: CookieSetter,
  deps: SeedDeps = {},
): Promise<boolean> {
  try {
    const lang = await (deps.readReadingLang ?? profileReadingLang)(userId)
    if (!isReadingLanguage(lang)) return false
    setCookie(READING_LANG_COOKIE, readingLangCookie(userId, lang), READING_LANG_COOKIE_OPTIONS)
    return true
  } catch (err) {
    const warn =
      deps.warn ?? ((message: string, context: { err: string }) => console.warn(message, context))
    warn('[tela] could not seed the reading-language cookie', { err: String(err) })
    return false
  }
}

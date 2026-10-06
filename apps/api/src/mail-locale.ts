/**
 * Which language a mail is written in (ADRs 0013 and 0038). A code mail usually goes out before an
 * account, and so an account's language, exists; the browser that asked for it says what it can:
 *
 * 1. the `tela_locale` cookie, which the reader sets when someone picks a language, and which wins
 *    over everything else there too (`detectLocale` in the reader);
 * 2. the account's interface language (`profiles.ui_locale`), when the address has an account;
 * 3. the browser's `Accept-Language`, read as the reader reads it (`negotiateLocale`);
 * 4. English.
 *
 * A notice about an account's ways in reads the account alone: it goes to whoever holds the
 * address, and whoever made the change, whose browser it would otherwise follow, may be someone
 * else. Whatever the language, English is written beside it (`mail.ts`).
 */
import { first, type TelaDb } from '@tela/data'
import {
  DEFAULT_UI_LOCALE,
  isUiLocale,
  negotiateLocale,
  preferredLanguages,
  type UiLocale,
} from '@tela/shared'
import { sql } from 'drizzle-orm'

/** The reader's cookie for the language someone picked (`LOCALE_COOKIE` in the reader). */
const LOCALE_COOKIE = 'tela_locale'
const LOCALE_PAIR = new RegExp(`(?:^|;\\s*)${LOCALE_COOKIE}=([^;]+)`)

/**
 * The language a `cookie` header says was picked, or null. A value that does not decode, or is no
 * language Tela has, is no choice.
 */
function pickedLocale(cookie: string | null | undefined): UiLocale | null {
  const value = cookie?.match(LOCALE_PAIR)?.[1]
  if (value === undefined) return null
  try {
    const decoded = decodeURIComponent(value)
    return isUiLocale(decoded) ? decoded : null
  } catch {
    return null
  }
}

export function mailLocale(from: {
  /** The request's `cookie` header. */
  cookie?: string | null | undefined
  /** The request's `Accept-Language` header. */
  acceptLanguage?: string | null | undefined
  /** The account's interface language, as stored. */
  account?: string | null | undefined
}): UiLocale {
  const picked = pickedLocale(from.cookie)
  if (picked) return picked
  if (isUiLocale(from.account)) return from.account
  if (from.acceptLanguage) return negotiateLocale(preferredLanguages(from.acceptLanguage))
  return DEFAULT_UI_LOCALE
}

/**
 * What of a request says its language, and nothing else: the language cookie alone, and
 * `Accept-Language`. tela-api's own call to better-auth for a visitor's join passes these on, so
 * the code mail is in the joiner's language, without handing better-auth the visitor's session
 * cookie or any other header of theirs.
 */
export function languageHeaders(from: Headers): Headers {
  const headers = new Headers()
  const pair = from.get('cookie')?.match(LOCALE_PAIR)?.[0]
  if (pair) headers.set('cookie', pair.replace(/^;\s*/, ''))
  const acceptLanguage = from.get('accept-language')
  if (acceptLanguage) headers.set('accept-language', acceptLanguage)
  return headers
}

/** A member's interface language, for a notice to them: English when they never chose one. */
export async function accountLocale(db: TelaDb, userId: string): Promise<UiLocale> {
  const found = await first<{ ui_locale: string | null }>(
    db,
    sql`select ui_locale from profiles where user_id = ${userId}`,
  )
  return mailLocale({ account: found?.ui_locale })
}

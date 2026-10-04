/**
 * The UI's language. The same catalogues as before (`messages/*.json`), read through use-intl,
 * which is next-intl's framework-free core, so every key and ICU pattern carries over unchanged.
 */
import { isUiLocale, negotiateLocale, type UiLocale } from '@tela/shared'
import { IntlProvider } from 'use-intl'
import en from '../messages/en.json'
import zhHans from '../messages/zh-Hans.json'
import zhHant from '../messages/zh-Hant.json'
import { safeDecode } from './lib/safe-decode'

export const MESSAGES: Record<UiLocale, typeof en> = { en, 'zh-Hans': zhHans, 'zh-Hant': zhHant }
export const LOCALE_COOKIE = 'tela_locale'

/**
 * The cookie wins (so the edge renders public pages in the same language), then the browser's
 * languages in its order of preference. A cookie that does not decode is no choice: it would
 * otherwise fail the app's boot and every page the edge renders, for as long as the browser keeps
 * it.
 */
export function detectLocale(cookie: string, languages: readonly string[]): UiLocale {
  const match = cookie.match(/(?:^|;\s*)tela_locale=([^;]+)/)
  const chosen = match ? safeDecode(match[1] ?? '') : null
  if (isUiLocale(chosen)) return chosen
  return negotiateLocale(languages)
}

export function localeCookie(locale: UiLocale): string {
  return `${LOCALE_COOKIE}=${encodeURIComponent(locale)}; Path=/; Max-Age=31536000; SameSite=Lax`
}

export function I18n({ locale, children }: { locale: UiLocale; children: React.ReactNode }) {
  return (
    <IntlProvider
      locale={locale}
      messages={MESSAGES[locale]}
      timeZone={Intl.DateTimeFormat().resolvedOptions().timeZone}
    >
      {children}
    </IntlProvider>
  )
}

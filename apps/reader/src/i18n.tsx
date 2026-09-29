/**
 * The UI's language. The same catalogues as before (`messages/*.json`), read through use-intl,
 * which is next-intl's framework-free core, so every key and ICU pattern carries over unchanged.
 */
import { UI_LOCALES, type UiLocale } from '@tela/shared'
import { IntlProvider } from 'use-intl'
import en from '../messages/en.json'
import zhHans from '../messages/zh-Hans.json'

export const MESSAGES: Record<UiLocale, typeof en> = { en, 'zh-Hans': zhHans }
export const LOCALE_COOKIE = 'tela_locale'

export function isUiLocale(v: unknown): v is UiLocale {
  return typeof v === 'string' && (UI_LOCALES as readonly string[]).includes(v)
}

/** The cookie wins (so the edge renders public pages in the same language), then the browser. */
export function detectLocale(cookie: string, languages: readonly string[]): UiLocale {
  const match = cookie.match(/(?:^|;\s*)tela_locale=([^;]+)/)
  const chosen = match ? decodeURIComponent(match[1] ?? '') : null
  if (isUiLocale(chosen)) return chosen
  return languages.some((l) => l.toLowerCase().startsWith('zh')) ? 'zh-Hans' : 'en'
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

/**
 * The UI's language. The same catalogues as before (`messages/*.json`), read through use-intl,
 * which is next-intl's framework-free core, so every key and ICU pattern carries over unchanged.
 */
import { isUiLocale, negotiateLocale, type UiLocale } from '@tela/shared'
import { IntlProvider } from 'use-intl'
import en from '../messages/en.json'
import fr from '../messages/fr.json'
import zhHans from '../messages/zh-Hans.json'
import zhHant from '../messages/zh-Hant.json'
import { safeDecode } from './lib/safe-decode'
import type { LocalStore } from './store/local'

export const MESSAGES: Record<UiLocale, typeof en> = {
  'zh-Hans': zhHans,
  'zh-Hant': zhHant,
  en,
  fr,
}
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

/** What choosing an interface language needs of the device store. */
type Choosing = Pick<LocalStore, 'userId' | 'mutate' | 'getSnapshot'>

/**
 * An interface language chosen, in Settings or the header (ADR 0040), and the language the page
 * is to be in once it is: null for none to change to. A visitor's goes on the page as it is. A
 * member's is their profile's, and the page shows what the store makes of it, never the choice
 * itself, as the theme menu does (ADR 0037): each language goes to the later `at`, so a choice can
 * lose to one made later elsewhere, or to a clock behind it, and a page painted from it would
 * then be in a language the account does not hold, with nothing to put it right, since the row
 * never changes. A choice is a mutation even before the first sync has brought the profile: it
 * waits with the others, and lands on the row when that arrives (skipping it then left only the
 * cookie, and the row's older choice took the page back). Meanwhile no row says otherwise, so the
 * page takes the choice, and the app applies whatever the row makes of it once it lands.
 */
export function chooseLocale(store: Choosing, next: UiLocale): UiLocale | null {
  if (store.userId === null) return next
  store.mutate({ type: 'setProfile', uiLocale: next })
  const held = store.getSnapshot().tables.profile
  if (!held) return next
  return isUiLocale(held.uiLocale) ? held.uiLocale : null
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

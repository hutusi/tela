/**
 * The UI's language. The same catalogues as before (`messages/*.json`), read through use-intl,
 * which is next-intl's framework-free core, so every key and ICU pattern carries over unchanged.
 */
import {
  hlLocale,
  isUiLocale,
  negotiateLocale,
  preferredLanguages,
  type UiLocale,
} from '@tela/shared'
import type { ProfileRow } from '@tela/sync'
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
 * The interface language chosen on this browser, as the `tela_locale` cookie keeps it, or null
 * for none: no cookie, a language this build does not have, or a cookie that does not decode,
 * which would otherwise fail the app's boot and every page the edge renders, for as long as the
 * browser keeps it.
 */
export function chosenLocale(cookie: string): UiLocale | null {
  const match = cookie.match(/(?:^|;\s*)tela_locale=([^;]+)/)
  const chosen = match ? safeDecode(match[1] ?? '') : null
  return isUiLocale(chosen) ? chosen : null
}

/** The language an address fixes with `?hl=` (ADR 0060), or null when it fixes none. */
export function pinnedLocale(search: string | URLSearchParams): UiLocale | null {
  const params = typeof search === 'string' ? new URLSearchParams(search) : search
  return hlLocale(params.get('hl'))
}

/**
 * A page's interface language: the one its address fixes (`pinned`, from `?hl=`), then the cookie
 * (so the edge renders public pages in the language chosen here), then the browser's languages in
 * its order of preference. An address never overrides a member's own choice: a caller passes no
 * `pinned` for one (ADR 0060).
 */
export function detectLocale(
  cookie: string,
  languages: readonly string[],
  pinned: UiLocale | null = null,
): UiLocale {
  return pinned ?? chosenLocale(cookie) ?? negotiateLocale(languages)
}

/**
 * The session cookie's name, by which the edge tells a member's request (ADR 0035): its presence
 * alone, `__Secure-` prefixed or not, never whether it is still good.
 */
export const SESSION_COOKIE = 'tela.session_token'

/**
 * The language the edge renders a public page in (ADR 0060): a visitor's `?hl=`, then their
 * cookie, then Accept-Language; a member's cookie, which follows their account, then
 * Accept-Language, whatever the address says.
 */
export function requestLocale(request: Request): UiLocale {
  const cookie = request.headers.get('cookie') ?? ''
  const member = cookie.includes(SESSION_COOKIE)
  const languages = preferredLanguages(request.headers.get('accept-language') ?? '')
  return detectLocale(
    cookie,
    languages,
    member ? null : pinnedLocale(new URL(request.url).searchParams),
  )
}

/**
 * The language the app first renders in. A page the edge rendered is in the language the edge
 * chose (`rendered`, its `<html lang>`), from what this script cannot read, since the session
 * cookie is HttpOnly: the app paints over it in the same words. Any other page takes the edge's
 * order, with a device that holds an account (`member`) standing for the session cookie.
 */
export function bootLocale(member: boolean, rendered: string | null = null): UiLocale {
  if (isUiLocale(rendered)) return rendered
  return detectLocale(
    document.cookie,
    navigator.languages ?? [navigator.language],
    member ? null : pinnedLocale(window.location.search),
  )
}

/**
 * The interface language an account takes from this browser once its profile is here: the one its
 * visitor chose before joining, once. Never over the account's own, whatever it says, and only
 * from the cookie, a choice made here: the browser's own languages are no choice, and an account
 * that has none follows them already, on each browser its own. A browser shared by two accounts
 * gives the second whatever it shows, which is what that member is reading anyway.
 */
export function localeToAdopt(
  profile: Pick<ProfileRow, 'uiLocale'> | null,
  cookie: string,
): UiLocale | null {
  if (!profile || profile.uiLocale !== null) return null
  return chosenLocale(cookie)
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

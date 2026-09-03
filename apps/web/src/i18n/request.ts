import { DEFAULT_UI_LOCALE, isUiLocale, type UiLocale } from '@tela/shared'
import { cookies, headers } from 'next/headers'
import { getRequestConfig } from 'next-intl/server'

export const LOCALE_COOKIE = 'tela_locale'

async function resolveLocale(): Promise<UiLocale> {
  const store = await cookies()
  const fromCookie = store.get(LOCALE_COOKIE)?.value
  if (isUiLocale(fromCookie)) return fromCookie
  const accept = (await headers()).get('accept-language')?.toLowerCase() ?? ''
  if (accept.startsWith('zh')) return 'zh-Hans'
  return DEFAULT_UI_LOCALE
}

export default getRequestConfig(async () => {
  const locale = await resolveLocale()
  const messages = (await import(`../../messages/${locale}.json`)).default
  return { locale, messages }
})

'use server'

import { isUiLocale } from '@tela/shared'
import { revalidatePath } from 'next/cache'
import { cookies } from 'next/headers'
import { LOCALE_COOKIE } from '@/i18n/request'

export async function setLocale(form: FormData): Promise<void> {
  const locale = form.get('locale')
  if (!isUiLocale(locale)) return
  const store = await cookies()
  store.set(LOCALE_COOKIE, locale, { path: '/', maxAge: 365 * 24 * 3600, sameSite: 'lax' })
  revalidatePath('/', 'layout')
}

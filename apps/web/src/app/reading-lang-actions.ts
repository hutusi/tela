'use server'

import { setReadingLang as persist } from '@tela/db/queries'
import { isReadingLanguage } from '@tela/shared'
import { revalidatePath } from 'next/cache'
import { requireUser } from '@/lib/auth'
import { getDb } from '@/lib/platform/db'

export async function setReadingLang(form: FormData): Promise<void> {
  const lang = form.get('lang')
  if (!isReadingLanguage(lang)) return
  const user = await requireUser()
  await persist(await getDb(), user.id, lang)
  revalidatePath('/', 'layout')
}

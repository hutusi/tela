'use server'

import { setTranslationOptOut } from '@tela/db/queries'
import { revalidatePath } from 'next/cache'
import { requireUser } from '@/lib/auth'
import { getDb } from '@/lib/platform/db'

export async function setTranslationOptOutAction(form: FormData): Promise<void> {
  const user = await requireUser('/dashboard')
  const siteId = Number(form.get('siteId'))
  if (!Number.isInteger(siteId) || siteId <= 0) return
  await setTranslationOptOut(await getDb(), siteId, user.id, form.get('optOut') === '1')
  revalidatePath('/dashboard')
}

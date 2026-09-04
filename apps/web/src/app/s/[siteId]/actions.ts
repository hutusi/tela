'use server'

import { setSiteTopics } from '@tela/db/queries'
import { revalidatePath } from 'next/cache'
import { requireUser } from '@/lib/auth'
import { getDb } from '@/lib/platform/db'

/** Owners curate their site's topics. */
export async function setTopicsAction(form: FormData): Promise<void> {
  const user = await requireUser()
  const siteId = Number(form.get('siteId'))
  if (!Number.isInteger(siteId) || siteId <= 0) return
  const topics = form.getAll('topics').map(String)
  await setSiteTopics(await getDb(), siteId, user.id, topics)
  revalidatePath(`/s/${siteId}`)
  revalidatePath('/discover')
}

'use server'

import { subscribe, unsubscribe } from '@tela/db/queries'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { requireUser } from '@/lib/auth'
import { getDb } from '@/lib/platform/db'
import { enqueueFeedFetch } from '@/lib/queue'
import { safeNext } from '@/lib/redirect'

/** Subscribe or unsubscribe from a site's feed; `next` is where to return. */
export async function toggleSubscriptionAction(form: FormData): Promise<void> {
  const next = safeNext(form.get('next'), '/discover')
  const user = await requireUser(next)
  const feedId = Number(form.get('feedId'))
  const subscribed = form.get('subscribed') === '1'
  if (!Number.isInteger(feedId) || feedId <= 0) redirect(next)
  const db = await getDb()
  if (subscribed) {
    await unsubscribe(db, user.id, feedId)
  } else {
    const { created } = await subscribe(db, user.id, feedId)
    if (created) await enqueueFeedFetch(db, feedId)
  }
  revalidatePath('/discover')
  revalidatePath('/s/[siteId]', 'page')
  redirect(next)
}

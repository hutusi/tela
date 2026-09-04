'use server'

import { markAllRead, markRead, toggleLike } from '@tela/db/queries'
import { revalidatePath } from 'next/cache'
import { requireUser } from '@/lib/auth'
import { getDb } from '@/lib/platform/db'

function id(value: unknown): number | null {
  const n = Number(value)
  return Number.isInteger(n) && n > 0 ? n : null
}

export async function markReadAction(articleId: number): Promise<void> {
  const user = await requireUser()
  const target = id(articleId)
  if (!target) return
  await markRead(await getDb(), user.id, target)
  revalidatePath('/reading')
}

export async function markAllReadAction(form: FormData): Promise<void> {
  const user = await requireUser()
  const feedId = id(form.get('feedId'))
  await markAllRead(await getDb(), user.id, feedId)
  revalidatePath('/reading')
}

export async function toggleLikeAction(
  articleId: number,
): Promise<{ liked: boolean; likeCount: number }> {
  const user = await requireUser()
  const target = id(articleId)
  if (!target) return { liked: false, likeCount: 0 }
  const result = await toggleLike(await getDb(), user.id, target)
  revalidatePath('/reading')
  return result
}

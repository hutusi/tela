'use server'

import { articles } from '@tela/db'
import {
  consumeRateLimit,
  markAllRead,
  markRead,
  recommend,
  requestBodyTranslation,
  toggleLike,
  unrecommend,
} from '@tela/db/queries'
import { createJobSender } from '@tela/db/queue'
import { isReadingLanguage } from '@tela/shared'
import { eq } from 'drizzle-orm'
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

/** Ask for a body translation; enqueues translate.body at reader priority when new. */
export async function requestTranslationAction(
  articleId: number,
  targetLang: string,
): Promise<'requested' | 'in_progress' | 'ready' | 'invalid' | 'rate_limited' | 'unavailable'> {
  const user = await requireUser()
  const target = id(articleId)
  if (!target || !isReadingLanguage(targetLang)) return 'invalid'
  const db = await getDb()
  // On-demand requests skip the daily budget, so this is the only ceiling on what one account
  // can make the model do.
  if (!(await consumeRateLimit(db, 'translate', user.id)).allowed) return 'rate_limited'
  const [article] = await db
    .select({ contentHash: articles.contentHash })
    .from(articles)
    .where(eq(articles.id, target))
  if (!article) return 'invalid'
  // The job is inserted in the same transaction as the `requested` status (ADR 0004): if the
  // queue is unavailable the status rolls back too, and the reader can simply ask again.
  return requestBodyTranslation(db, target, targetLang, article.contentHash, async (tx) => {
    await createJobSender(tx).send(
      'translate.body',
      { articleId: target, targetLang, onDemand: true },
      { singletonKey: `${target}:${targetLang}`, priority: 10 },
    )
  }).catch((err: unknown) => {
    console.warn('[tela] could not request translate.body', {
      articleId: target,
      err: String(err),
    })
    return 'unavailable' as const
  })
}

export async function recommendAction(
  articleId: number,
  note: string | null,
): Promise<{ recommended: boolean; recommendCount: number }> {
  const user = await requireUser()
  const target = id(articleId)
  if (!target) return { recommended: false, recommendCount: 0 }
  const result = await recommend(await getDb(), user.id, target, note)
  revalidatePath('/reading')
  return { recommended: true, recommendCount: result.recommendCount }
}

export async function unrecommendAction(
  articleId: number,
): Promise<{ recommended: boolean; recommendCount: number }> {
  const user = await requireUser()
  const target = id(articleId)
  if (!target) return { recommended: false, recommendCount: 0 }
  const result = await unrecommend(await getDb(), user.id, target)
  revalidatePath('/reading')
  return { recommended: false, recommendCount: result.recommendCount }
}

'use server'

import { getClaim, resetClaim } from '@tela/db/queries'
import { createJobSender } from '@tela/db/queue'
import { revalidatePath } from 'next/cache'
import { requireUser } from '@/lib/auth'
import { getDb } from '@/lib/platform/db'

/** Queue verification of the user's claim (resets a failed attempt first). */
export async function verifyClaimAction(form: FormData): Promise<void> {
  const user = await requireUser()
  const claimId = Number(form.get('claimId'))
  if (!Number.isInteger(claimId) || claimId <= 0) return
  const db = await getDb()
  const claim = await getClaim(db, claimId)
  if (!claim || claim.userId !== user.id || claim.status === 'verified') return
  if (claim.status === 'failed') await resetClaim(db, claimId)
  try {
    await createJobSender(db).send(
      'site.claim.verify',
      { claimId },
      { singletonKey: String(claimId) },
    )
  } catch (err) {
    console.warn('[tela] could not enqueue site.claim.verify', { claimId, err: String(err) })
  }
  revalidatePath(`/sites/${claim.siteId}/claim`)
}

/**
 * `member.erase` (ADR 0058): the second phase of closing an account. `closeAccount` (tela-api)
 * emptied what anyone else could see and ended every way in; this removes what only the member's
 * own devices held, once no signed copy of their session can still be read (`ERASE_AFTER_MS`).
 *
 * Every chunk is a fenced batch that holds the lease for the next (invariant 6), so a run that
 * loses its lease writes nothing more, and a run cut short (its time, or its batches) releases the
 * lease and is claimed again at the next tick, carrying on where the last batch left off: every
 * step selects what is left, never a list read earlier. The member's uploaded pictures go last,
 * then the profile is stamped erased, and only while nothing is left and no translation of theirs
 * is still running; otherwise the next tick claims it again.
 */
import {
  avatarPrefix,
  ERASE_CHUNK,
  ERASE_STEPS,
  finishErasure,
  first,
  type Lease,
} from '@tela/data'
import { commit } from '@tela/ingest/pipeline'
import type { Blobs } from '@tela/platform'
import { sql } from 'drizzle-orm'
import type { StepResult, WorkContext } from './kinds'

/** How long a claim holds before the first chunk; each chunk's batch extends it by as much. */
export const ERASE_TTL_MS = 2 * 60_000
/** A run stops starting chunks after this long, well inside a queue consumer's fifteen minutes. */
export const ERASE_RUN_MS = 5 * 60_000
/**
 * And after this many batches: each is a handful of D1 queries, and an invocation makes at most
 * 1,000 of them.
 */
export const ERASE_RUN_BATCHES = 120

export type EraseResult = StepResult &
  ({ status: 'erased' | 'continued' | 'waiting'; batches: number } | { status: 'skipped' | 'lost' })

/**
 * Delete every object under the member's picture prefix. Each listing is of what is left, so a
 * deletion that the store has not yet shown in a listing is only tried again.
 */
async function deletePictures(blobs: Blobs, userId: string): Promise<void> {
  const prefix = avatarPrefix(userId)
  for (let round = 0; round < 100; round++) {
    const { keys } = await blobs.list({ prefix, limit: 100 })
    if (keys.length === 0) return
    for (const key of keys) await blobs.delete(key)
  }
  throw new Error(`pictures under ${prefix} kept coming back`)
}

export async function eraseMemberJob(ctx: WorkContext, lease: Lease): Promise<EraseResult> {
  const { db } = ctx
  const userId = lease.key
  const member = await first<{ deleted_at: number | null; erased_at: number | null }>(
    db,
    sql`select deleted_at, erased_at from profiles where user_id = ${userId}`,
  )
  if (!member || member.deleted_at === null || member.erased_at !== null) {
    const committed = await commit(ctx, lease, [])
    return committed.ok ? { status: 'skipped' } : { status: 'lost' }
  }
  const deadline = ctx.clock.now() + ERASE_RUN_MS
  let batches = 0
  for (const step of ERASE_STEPS) {
    for (;;) {
      if (ctx.clock.now() >= deadline || batches >= ERASE_RUN_BATCHES) {
        const committed = await commit(ctx, lease, [])
        return committed.ok ? { status: 'continued', batches } : { status: 'lost' }
      }
      const chunk = step(db, userId, ctx.clock.now())
      const committed = await commit(ctx, lease, chunk.statements, {
        hold: { ttlMs: ERASE_TTL_MS },
      })
      if (!committed.ok) return { status: 'lost' }
      batches++
      // The fence and the seq come first in a committed batch.
      const took = committed.results[2 + chunk.counted]
      if (!Array.isArray(took) || took.length < ERASE_CHUNK) break
    }
  }
  await deletePictures(ctx.blobs, userId)
  const statements = finishErasure(db, userId, ctx.clock.now())
  const committed = await commit(ctx, lease, statements)
  if (!committed.ok) return { status: 'lost' }
  const stamped = committed.results[2 + statements.length - 1]
  batches++
  return Array.isArray(stamped) && stamped.length > 0
    ? { status: 'erased', batches }
    : { status: 'waiting', batches }
}

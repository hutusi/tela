/**
 * Asking Gravatar about a member now rather than at the next sweep (ADR 0033): after a push turns
 * their Gravatar on, or asks again, the check is claimed here and sent to tela-jobs, as a claim
 * verification is, so their picture (or their letter) settles in seconds.
 */
import { claimDue, dueGravatarChecks, GRAVATAR_CHECK_TTL_MS } from '@tela/data'
import { sql } from 'drizzle-orm'
import type { ApiDeps } from '../deps'

export async function checkGravatarSoon(deps: ApiDeps, userId: string): Promise<void> {
  // Read the clock again: the push stamped its rows at this request's start, and a check claimed
  // with that `now` could miss a row the push made due.
  const now = deps.clock.now()
  const owner = `member.gravatar:api:${now.toString(36)}`
  const claimed = await claimDue(deps.db, {
    kind: 'member.gravatar',
    owner,
    now,
    ttlMs: GRAVATAR_CHECK_TTL_MS,
    limit: 1,
    due: sql`select * from (${dueGravatarChecks(now)}) where key = ${userId}`,
  })
  // Another member's check holding gravatar.com's lease: the next sweep takes this one.
  if (claimed.length > 0) {
    await deps.jobs.send('misc', { kind: 'member.gravatar', key: userId, owner })
  }
}

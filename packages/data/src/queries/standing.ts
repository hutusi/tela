/**
 * A member's standing (ADRs 0058, 0059): a closed account (`profiles.deleted_at`) and a
 * suspended one (`suspended_at`) cannot sign in, and nothing public shows them. One predicate,
 * so every public query and every guard hides the same accounts.
 */
import { type SQL, sql } from 'drizzle-orm'

/** True (as SQL) for a profile in good standing; `alias` names the `profiles` row in the query. */
export function standingOk(alias = 'profiles'): SQL {
  const p = sql.raw(alias)
  return sql`(${p}.deleted_at is null and ${p}.suspended_at is null)`
}

/** True (as SQL) when the member `userId` is in good standing. */
export function memberInStanding(userId: string): SQL {
  return sql`exists (select 1 from profiles where user_id = ${userId}
    and deleted_at is null and suspended_at is null)`
}

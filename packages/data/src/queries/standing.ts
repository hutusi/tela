/**
 * A member's standing (ADRs 0058, 0059): a closed account (`profiles.deleted_at`) and a
 * suspended one (`suspended_at`) cannot sign in, and nothing public shows them. One predicate,
 * so every public query and every guard hides the same accounts.
 */
import { type SQL, sql } from 'drizzle-orm'
import type { TelaDb } from '../db'
import { first } from '../first'

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

/**
 * Whether the member is out of good standing: closed or suspended. A member with no profile yet
 * (its insert failed, and the next sign-in repairs it) is not, so the guards refuse only accounts
 * that were closed or suspended.
 */
export async function isBarred(db: TelaDb, userId: string): Promise<boolean> {
  const row = await first<{ barred: number }>(
    db,
    sql`select 1 as barred from profiles p where p.user_id = ${userId} and not ${standingOk('p')}`,
  )
  return row !== undefined
}

/**
 * The member's standing and whether they are an admin, in one read: what tela-api's member check
 * reads before a call that matters (ADRs 0058, 0059), and what the web's actor takes its `exempt`
 * from (ADR 0065), so neither costs a round trip of its own. No profile is neither barred nor an
 * admin.
 */
export async function memberStanding(
  db: TelaDb,
  userId: string,
): Promise<{ barred: boolean; admin: boolean }> {
  const row = await first<{ barred: number; admin: number }>(
    db,
    sql`select not ${standingOk('p')} as barred, p.is_admin = 1 as admin
      from profiles p where p.user_id = ${userId}`,
  )
  return { barred: row?.barred === 1, admin: row?.admin === 1 }
}

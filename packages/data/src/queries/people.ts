/**
 * Where a person's picture lives (ADR 0032, 0033). Every query that returns a person selects it
 * from here, and the reader renders whatever path it is given, so this is the one place that
 * decides which picture a member has: the one they uploaded, else their Gravatar, else none (the
 * letter, and no request at all).
 */
import { type SQL, sql } from 'drizzle-orm'

const DAY = 24 * 60 * 60 * 1000
/** How long an answer from Gravatar stands before it is asked again: a picture, and none. */
export const GRAVATAR_RECHECK_FOUND_MS = 30 * DAY
export const GRAVATAR_RECHECK_MISSING_MS = 7 * DAY

function checked(alias: string): string {
  if (!/^[a-z_]+$/.test(alias)) throw new Error(`not an alias: ${alias}`)
  return alias
}

/** Whether the member shows their Gravatar: on until they choose, then what they chose (0033). */
export function gravatarOnSql(alias: string): string {
  const a = checked(alias)
  return `(${a}.gravatar = 1 or ${a}.gravatar_at = 0)`
}

/**
 * The SQL for a member's picture over the profiles row aliased `alias`: `/avatar/<userId>?v=<n>`
 * while they have an upload, or a Gravatar they show and Gravatar has, else null. The version
 * moves whenever the picture may have, so each address is one picture, cached for 30 days.
 */
export function avatarSql(alias: string): string {
  const a = checked(alias)
  return `case when ${a}.avatar_key is not null or (${gravatarOnSql(a)} and ${a}.gravatar_found = 1)
    then '/avatar/' || ${a}.user_id || '?v=' || ${a}.avatar_version end`
}

/** `avatarSql` as a fragment, for queries built with `sql`. */
export function avatarOf(alias: string): SQL {
  return sql.raw(avatarSql(alias))
}

/** `gravatarOnSql` as a fragment. */
export function gravatarOn(alias: string): SQL {
  return sql.raw(gravatarOnSql(alias))
}

/**
 * Members whose Gravatar is due a check (ADR 0033): shown, and never asked, or asked longer ago
 * than the answer stands. Leased by one host, gravatar.com, so they are asked one at a time.
 */
export const dueGravatarChecks = (now: number): SQL =>
  sql`select p.user_id as key, 'gravatar.com' as host, coalesce(p.gravatar_checked_at, 0) as ord
      from profiles p
      where ${gravatarOn('p')} and (p.gravatar_checked_at is null
        or (p.gravatar_found = 1 and p.gravatar_checked_at <= ${now - GRAVATAR_RECHECK_FOUND_MS})
        or (coalesce(p.gravatar_found, 0) = 0 and p.gravatar_checked_at <= ${now - GRAVATAR_RECHECK_MISSING_MS}))`

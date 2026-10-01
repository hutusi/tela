/**
 * Where a person's picture lives (ADR 0032). Every query that returns a person selects it from
 * here, and the reader renders whatever path it is given, so this is the one place to change when
 * the picture comes from somewhere else (an upload, next).
 */
import { type SQL, sql } from 'drizzle-orm'

/**
 * The SQL for a member's picture over the profiles row aliased `alias`: their Gravatar, served
 * through Tela at `/avatar/<userId>?v=<gravatar_at>`, or null while they have not turned it on.
 * The version is the switch's clock, so Refresh (the switch sent on again) is a new address.
 */
export function avatarSql(alias: string): string {
  if (!/^[a-z_]+$/.test(alias)) throw new Error(`not an alias: ${alias}`)
  return `case when ${alias}.gravatar then '/avatar/' || ${alias}.user_id || '?v=' || ${alias}.gravatar_at end`
}

/** `avatarSql` as a fragment, for queries built with `sql`. */
export function avatarOf(alias: string): SQL {
  return sql.raw(avatarSql(alias))
}

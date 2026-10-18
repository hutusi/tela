/**
 * What an operator does to a member's public blogroll (ADR 0050): hide it from Discover, and
 * restore it. A hidden blogroll keeps its page and its place on its member's profile; only
 * Discover leaves it out.
 *
 * `hidden_at` is the operator's alone: no device holds it, so neither action bumps the sequence or
 * stamps `seq`, and neither touches `updated_at`, which is the member's clock for the name and
 * description. Its member is not told.
 */
import type { AdminActionName } from '@tela/shared/admin'
import { sql } from 'drizzle-orm'
import type { ActHandler, Inverse } from '../framework'
import { applyChange, blogrollIdOf, restoreColumns } from './common'

/** A blogroll others can open: public, and not deleted. Discover lists only these. */
const SHOWN = sql`is_public = 1 and deleted_at is null`

/** Hide a public blogroll from Discover, whatever its count: Discover then never lists it. */
const hide: ActHandler = async (ctx, id) => {
  const blogrollId = blogrollIdOf(id)
  if (blogrollId === null) return 'not_found'
  return applyChange(ctx, {
    action: 'blogroll.hide',
    table: 'blogrolls',
    id: blogrollId,
    applies: sql`${SHOWN} and hidden_at is null`,
    set: sql`hidden_at = ${ctx.now}`,
    from: sql`json_object('hiddenAt', hidden_at)`,
    to: { hiddenAt: ctx.now },
    synced: false,
  })
}

/** Let Discover list a hidden blogroll again, once it has enough blogs others see. */
const restore: ActHandler = async (ctx, id) => {
  const blogrollId = blogrollIdOf(id)
  if (blogrollId === null) return 'not_found'
  return applyChange(ctx, {
    action: 'blogroll.restore',
    table: 'blogrolls',
    id: blogrollId,
    applies: sql`${SHOWN} and hidden_at is not null`,
    set: sql`hidden_at = null`,
    from: sql`json_object('hiddenAt', hidden_at)`,
    to: { hiddenAt: null },
    synced: false,
  })
}

/**
 * Put the Hide back as it was, while it is still what the action left. Whether the member has
 * made the blogroll private or deleted it since does not matter: the Hide is the operator's
 * choice about Discover, and undoing it restores that choice alone.
 */
const restoreHidden = restoreColumns({
  table: 'blogrolls',
  columns: { hiddenAt: 'hidden_at' },
  synced: false,
})

export const blogrollActions = {
  'blogroll.hide': hide,
  'blogroll.restore': restore,
} satisfies Partial<Record<AdminActionName, ActHandler>>

export const blogrollInverses = {
  'blogroll.hide': restoreHidden,
  'blogroll.restore': restoreHidden,
} satisfies Partial<Record<AdminActionName, Inverse>>

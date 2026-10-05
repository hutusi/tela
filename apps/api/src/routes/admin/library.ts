/** Claims, Sites, Feeds and Discover: the blogs Tela knows, and the queues about them. */
import { audit, bumpSeq, currentSeq, type TelaDb } from '@tela/data'
import { COMMUNITY_LISTING_MIN_READERS, type SiteListing } from '@tela/shared'
import type { AdminActionName } from '@tela/shared/admin'
import { type SQL, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import type { ApiDeps } from '../../deps'
import {
  type ActHandler,
  type AdminEnv,
  type AdminModule,
  type Inverse,
  returned,
  runBatch,
} from './framework'

/**
 * What the doors say a site's listing is when no operator has a say (ADR 0018): listed once
 * someone claimed it or enough readers follow it, private otherwise. `site.restore` returns a
 * featured or hidden site here. `private` is never an operator's choice: on an unclaimed site the
 * next subscribe would list it again, so the veto that sticks is `rejected`.
 */
export const DOORS_SAY = sql`(case when claimed_by is not null
  or reader_count >= ${COMMUNITY_LISTING_MIN_READERS} then 'listed' else 'private' end)`

const SET_LISTING: Partial<Record<AdminActionName, { to: SQL; applies: SQL }>> = {
  'site.feature': { to: sql`'featured'`, applies: sql`listing <> 'featured'` },
  'site.list': { to: sql`'listed'`, applies: sql`listing <> 'listed'` },
  'site.hide': { to: sql`'rejected'`, applies: sql`listing <> 'rejected'` },
  'site.restore': {
    to: DOORS_SAY,
    applies: sql`listing in ('featured', 'rejected') and listing <> ${DOORS_SAY}`,
  },
}

/** The site's id from a request's id, or null. */
export const siteIdOf = (id: string): number | null => {
  const n = Number(id)
  return Number.isSafeInteger(n) && n > 0 && String(n) === id ? n : null
}

/** Feature, list, hide or restore one site: its listing, audited, with the seq readers follow. */
function setListing(action: AdminActionName): ActHandler {
  const rule = SET_LISTING[action]
  if (!rule) throw new Error(`${action} sets no listing`)
  return async (ctx, id) => {
    const siteId = siteIdOf(id)
    if (siteId === null) return 'not_found'
    const { db } = ctx.deps
    const results = await runBatch(db, [
      bumpSeq(db),
      audit(
        db,
        {
          group: ctx.group,
          actor: ctx.actor,
          action,
          targetKind: 'site',
          targetKey: id,
          at: ctx.now,
        },
        {
          from: sql`json_object('listing', listing)`,
          to: sql`json_object('listing', ${rule.to})`,
        },
        sql`from sites where id = ${siteId} and ${rule.applies}`,
      ),
      db.all(sql`
        update sites set listing = ${rule.to}, updated_at = ${ctx.now}, seq = ${currentSeq}
        where id = ${siteId} and ${rule.applies}
        returning id
      `),
      db.all(sql`select id from sites where id = ${siteId}`),
    ])
    if (returned(results[2]).length > 0) return 'done'
    return returned(results[3]).length > 0 ? 'not_applicable' : 'not_found'
  }
}

/** Put a site's listing back, while it still holds what the action set. */
const restoreListing: Inverse = (db: TelaDb, change, now) => {
  const siteId = Number(change.targetKey)
  const from = (change.from as { listing?: SiteListing } | null)?.listing ?? null
  const to = (change.to as { listing?: SiteListing } | null)?.listing ?? null
  return {
    changed: sql`not exists (select 1 from sites where id = ${siteId} and listing = ${to})`,
    restore: [
      db.run(sql`
        update sites set listing = ${from}, updated_at = ${now}, seq = ${currentSeq}
        where id = ${siteId} and listing = ${to}
      `),
    ],
    synced: true,
  }
}

export function libraryModule(deps: ApiDeps): AdminModule {
  void deps
  const routes = new Hono<AdminEnv>()
  return {
    routes,
    actions: {
      'site.feature': setListing('site.feature'),
      'site.list': setListing('site.list'),
      'site.hide': setListing('site.hide'),
      'site.restore': setListing('site.restore'),
    },
    inverses: {
      'site.feature': restoreListing,
      'site.list': restoreListing,
      'site.hide': restoreListing,
      'site.restore': restoreListing,
    },
  }
}

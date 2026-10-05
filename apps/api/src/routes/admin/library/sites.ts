/**
 * What an operator does to a blog: its listing, its topics, whether it is translated, and a fetch
 * of every feed it has. A blog's row syncs to its readers, so every change bumps the sequence.
 */
import { audit, bumpSeq, currentSeq, type TelaDb } from '@tela/data'
import { isTopic, type SiteListing } from '@tela/shared'
import type { AdminActionName } from '@tela/shared/admin'
import { type SQL, sql } from 'drizzle-orm'
import { fetchSoon } from '../../feeds'
import { type ActHandler, type Inverse, returned, runBatch } from '../framework'
import { applyChange, DOORS_SAY, idOf, restoreColumns, stamped } from './common'

const SET_LISTING: Partial<Record<AdminActionName, { to: SQL; applies: SQL }>> = {
  'site.feature': { to: sql`'featured'`, applies: sql`listing <> 'featured'` },
  'site.list': { to: sql`'listed'`, applies: sql`listing <> 'listed'` },
  'site.hide': { to: sql`'rejected'`, applies: sql`listing <> 'rejected'` },
  'site.restore': {
    to: DOORS_SAY,
    applies: sql`listing in ('featured', 'rejected') and listing <> ${DOORS_SAY}`,
  },
}

/** Feature, list, hide or restore one site: its listing, audited, with the seq readers follow. */
export function setListing(action: AdminActionName): ActHandler {
  const rule = SET_LISTING[action]
  if (!rule) throw new Error(`${action} sets no listing`)
  return async (ctx, id) => {
    const siteId = idOf(id)
    if (siteId === null) return 'not_found'
    return applyChange(ctx, {
      action,
      table: 'sites',
      id: siteId,
      applies: rule.applies,
      set: sql`listing = ${rule.to}`,
      from: sql`json_object('listing', listing)`,
      to: sql`json_object('listing', ${rule.to})`,
    })
  }
}

/** Put a site's listing back, while it still holds what the action set. */
export const restoreListing: Inverse = (db: TelaDb, change, now) => {
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

/** A site's topics as a JSON array in topic order: what `site.topics` replaced. */
const topicsOf = (siteId: number) =>
  sql`json((select json_group_array(topic) from
    (select topic from site_topics where site_id = ${siteId} order by topic)))`

/** True when a site's topics are exactly `topics` (distinct, as `site_topics` keeps them). */
const topicsAre = (siteId: number, topics: string[]) => sql`(
  (select count(*) from site_topics where site_id = ${siteId}) = ${topics.length}
  and (select count(*) from site_topics where site_id = ${siteId}
    and topic in (select value from json_each(${JSON.stringify(topics)}))) = ${topics.length})`

/**
 * Replace a site's topics. The site's row is stamped too: a reader's device learns a blog's
 * topics from nothing it syncs, but the claimant's own change does the same, and the stamp is
 * what lets the replacement run exactly when the change applied. Only Discover's topics are
 * kept; an unknown one is dropped, as a member's own edit drops it.
 */
const setTopics: ActHandler = async (ctx, id, args) => {
  const siteId = idOf(id)
  if (siteId === null) return 'not_found'
  if (!Array.isArray(args.topics)) return 'invalid'
  const topics = [...new Set(args.topics.filter(isTopic))].sort()
  return applyChange(ctx, {
    action: 'site.topics',
    table: 'sites',
    id: siteId,
    applies: sql`not ${topicsAre(siteId, topics)}`,
    from: topicsOf(siteId),
    to: topics,
    after: (db) => replaceTopics(db, siteId, topics),
  })
}

/** The statements that make a stamped site's topics `topics`. */
function replaceTopics(db: TelaDb, siteId: number, topics: string[]) {
  const applied = stamped('sites', siteId)
  return [
    db.run(sql`delete from site_topics where site_id = ${siteId} and ${applied}`),
    db.run(sql`
      insert into site_topics (site_id, topic)
      select ${siteId}, value from json_each(${JSON.stringify(topics)}) where ${applied}
    `),
  ]
}

/** Put a site's topics back, while they are still the ones the action set. */
const restoreTopics: Inverse = (db, change, now) => {
  const siteId = Number(change.targetKey)
  const strings = (value: unknown) =>
    Array.isArray(value) ? value.filter((t): t is string => typeof t === 'string') : []
  const from = strings(change.from)
  const to = strings(change.to)
  return {
    changed: sql`(not exists (select 1 from sites where id = ${siteId})
      or not ${topicsAre(siteId, to)})`,
    restore: [
      db.run(sql`
        update sites set updated_at = ${now}, seq = ${currentSeq}
        where id = ${siteId} and ${topicsAre(siteId, to)}
      `),
      ...replaceTopics(db, siteId, from),
    ],
    synced: true,
  }
}

/** Pause or allow translating a blog, as its owner can (ADR 0011). */
function setTranslation(action: 'site.translationOff' | 'site.translationOn'): ActHandler {
  const optOut = action === 'site.translationOff' ? 1 : 0
  return async (ctx, id) => {
    const siteId = idOf(id)
    if (siteId === null) return 'not_found'
    return applyChange(ctx, {
      action,
      table: 'sites',
      id: siteId,
      applies: sql`translation_opt_out <> ${optOut}`,
      set: sql`translation_opt_out = ${optOut}`,
      from: sql`json_object('translationOptOut', translation_opt_out)`,
      to: { translationOptOut: optOut },
    })
  }
}

const restoreTranslation = restoreColumns({
  table: 'sites',
  columns: { translationOptOut: 'translation_opt_out' },
})

/**
 * Fetch every active feed of a site now: each is marked as asked for, which makes it due, then
 * claimed and sent like a reader's first fetch. A feed whose fetch is already running keeps the
 * mark, and the next sweep fetches it again. One audit row for the site, naming the feeds.
 */
const fetchAll: ActHandler = async (ctx, id) => {
  const siteId = idOf(id)
  if (siteId === null) return 'not_found'
  const { db, jobs } = ctx.deps
  const active = sql`select id from feeds where site_id = ${siteId} and status = 'active'`
  const results = await runBatch(db, [
    bumpSeq(db),
    audit(
      db,
      {
        group: ctx.group,
        actor: ctx.actor,
        action: 'site.fetchAll',
        targetKind: 'site',
        targetKey: String(siteId),
        at: ctx.now,
      },
      { to: sql`json_object('feeds', json((select json_group_array(id) from (${active}))))` },
      sql`from sites where id = ${siteId} and exists (${active})`,
    ),
    db.all(sql`
      update feeds set refetch_requested_at = ${ctx.now}, updated_at = ${ctx.now},
        seq = ${currentSeq}
      where site_id = ${siteId} and status = 'active'
      returning id
    `),
    db.all(sql`select id from sites where id = ${siteId}`),
  ])
  const feeds = returned(results[2]) as { id: number }[]
  if (feeds.length === 0) return returned(results[3]).length > 0 ? 'not_applicable' : 'not_found'
  for (const feed of feeds) await fetchSoon(db, jobs, feed.id, ctx.now)
  return 'done'
}

export const siteActions = {
  'site.feature': setListing('site.feature'),
  'site.list': setListing('site.list'),
  'site.hide': setListing('site.hide'),
  'site.restore': setListing('site.restore'),
  'site.topics': setTopics,
  'site.translationOff': setTranslation('site.translationOff'),
  'site.translationOn': setTranslation('site.translationOn'),
  'site.fetchAll': fetchAll,
} satisfies Partial<Record<AdminActionName, ActHandler>>

export const siteInverses = {
  'site.feature': restoreListing,
  'site.list': restoreListing,
  'site.hide': restoreListing,
  'site.restore': restoreListing,
  'site.topics': restoreTopics,
  'site.translationOff': restoreTranslation,
  'site.translationOn': restoreTranslation,
} satisfies Partial<Record<AdminActionName, Inverse>>

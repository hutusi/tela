/**
 * What an operator does to a blog: its listing and its review for Discover, its topics, whether
 * it is translated, and a fetch of every feed it has. A blog's row syncs to its readers, so every
 * change bumps the sequence, bar Not for Discover, which writes only the review no device holds.
 */
import { audit, bumpSeq, currentSeq, type TelaDb } from '@tela/data'
import { isTopic, type SiteListing, type SiteReview } from '@tela/shared'
import type { AdminActionName } from '@tela/shared/admin'
import { type SQL, sql } from 'drizzle-orm'
import { fetchSoon } from '../../feeds'
import { type ActHandler, type Inverse, returned, runBatch } from '../framework'
import { applyChange, DOORS_SAY, idOf, restoreColumns, stamped } from './common'

/**
 * What each listing action sets, and what it records as the review for Discover (ADR 0041).
 * Feature and List decide `listed`, so a Restore, or a removed claim, returns the blog to listed
 * whatever its readers. Hide is the veto, not a review: it keeps a review already made, so a
 * listed blog hidden and restored is listed again, and records `dismissed` only where nothing was
 * decided. Each decision writes `reviewed_at` too, when the operator last decided: the stamp dates
 * the decision the review holds (or the veto over it), not one since overturned. Every decision
 * records the review and stamp it found, so undoing a mistaken List puts the blog back in the
 * queue. Restore is no decision: it returns the blog to what the doors say, and leaves the review.
 */
const SET_LISTING: Partial<Record<AdminActionName, { to: SQL; applies: SQL; review: SQL | null }>> =
  {
    'site.feature': {
      to: sql`'featured'`,
      applies: sql`listing <> 'featured'`,
      review: sql`'listed'`,
    },
    'site.list': { to: sql`'listed'`, applies: sql`listing <> 'listed'`, review: sql`'listed'` },
    'site.hide': {
      to: sql`'rejected'`,
      applies: sql`listing <> 'rejected'`,
      review: sql`coalesce(review, 'dismissed')`,
    },
    'site.restore': {
      to: DOORS_SAY,
      applies: sql`listing in ('featured', 'rejected') and listing <> ${DOORS_SAY}`,
      review: null,
    },
  }

/** Feature, list, hide or restore one site: its listing, audited, with the seq readers follow. */
export function setListing(action: AdminActionName): ActHandler {
  const rule = SET_LISTING[action]
  if (!rule) throw new Error(`${action} sets no listing`)
  const { review } = rule
  return async (ctx, id) => {
    const siteId = idOf(id)
    if (siteId === null) return 'not_found'
    return applyChange(ctx, {
      action,
      table: 'sites',
      id: siteId,
      applies: rule.applies,
      set: review
        ? sql`listing = ${rule.to}, review = ${review}, reviewed_at = ${ctx.now}`
        : sql`listing = ${rule.to}`,
      from: review
        ? sql`json_object('listing', listing, 'review', review, 'reviewedAt', reviewed_at)`
        : sql`json_object('listing', listing)`,
      // Read over the row before the change, as `from` is: what the change then writes.
      to: review
        ? sql`json_object('listing', ${rule.to}, 'review', ${review}, 'reviewedAt', ${ctx.now})`
        : sql`json_object('listing', ${rule.to})`,
    })
  }
}

type ListingChange = {
  listing?: SiteListing
  review?: SiteReview | null
  reviewedAt?: number | null
}

/**
 * Put a site's listing back, while it still holds what the action set, and the review and stamp
 * the action found when it recorded them. A Restore records neither, nor does an audit row from
 * before ADR 0041: their undo leaves the review as it is.
 */
export const restoreListing: Inverse = (db: TelaDb, change, now) => {
  const siteId = Number(change.targetKey)
  const from = (change.from ?? {}) as ListingChange
  const to = (change.to ?? {}) as ListingChange
  const decided = 'review' in from && 'review' in to
  const holds = decided
    ? sql`listing = ${to.listing ?? null} and review is ${to.review ?? null}
        and reviewed_at is ${to.reviewedAt ?? null}`
    : sql`listing = ${to.listing ?? null}`
  return {
    changed: sql`not exists (select 1 from sites where id = ${siteId} and ${holds})`,
    restore: [
      db.run(sql`
        update sites set listing = ${from.listing ?? null},
          ${decided ? sql`review = ${from.review ?? null}, reviewed_at = ${from.reviewedAt ?? null},` : sql``}
          updated_at = ${now}, seq = ${currentSeq}
        where id = ${siteId} and ${holds}
      `),
    ],
    synced: true,
  }
}

/**
 * Not for Discover (ADR 0041): take a blog a member added out of the review queue, deciding
 * against listing it. Only the review changes, and no device holds it, so nothing syncs. The
 * community door still lists the blog once three members read it (`recountReaders` does not look
 * at the review); Hide is the veto.
 */
const dismiss: ActHandler = async (ctx, id) => {
  const siteId = idOf(id)
  if (siteId === null) return 'not_found'
  return applyChange(ctx, {
    action: 'site.dismiss',
    table: 'sites',
    id: siteId,
    applies: sql`listing = 'private' and claimed_by is null and review is null`,
    set: sql`review = 'dismissed', reviewed_at = ${ctx.now}`,
    from: sql`json_object('review', review, 'reviewedAt', reviewed_at)`,
    to: { review: 'dismissed', reviewedAt: ctx.now },
    synced: false,
  })
}

/** Back to the review queue, while the review is still the one the dismiss wrote. */
const restoreReview = restoreColumns({
  table: 'sites',
  columns: { review: 'review', reviewedAt: 'reviewed_at' },
  synced: false,
})

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
  'site.dismiss': dismiss,
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
  'site.dismiss': restoreReview,
  'site.hide': restoreListing,
  'site.restore': restoreListing,
  'site.topics': restoreTopics,
  'site.translationOff': restoreTranslation,
  'site.translationOn': restoreTranslation,
} satisfies Partial<Record<AdminActionName, Inverse>>

/**
 * What an operator does about a claim (ADRs 0011, 0039): check it again, vouch for it, reject it
 * with a reason the claimant reads, take it out of the review queue, or remove a verified one. A
 * claim's row syncs to its claimant, so they see each of these on their own device.
 */
import { audit, bumpSeq, currentSeq, first, laterActionOn, type TelaDb } from '@tela/data'
import { COMMUNITY_LISTING_MIN_READERS, type SiteListing } from '@tela/shared'
import { type AdminActionName, actionsWriting, CLAIM_REMOVED_ERROR } from '@tela/shared/admin'
import { type SQL, sql } from 'drizzle-orm'
import { checkClaimSoon } from '../../claims'
import { type ActHandler, type Inverse, returned, runBatch } from '../framework'
import { applyChange, breakLease, idOf, restoreColumns, stamped } from './common'

/** Check a failed claim again, at once. The claimant sees it pending, then the answer. */
const recheck: ActHandler = async (ctx, id) => {
  const claimId = idOf(id)
  if (claimId === null) return 'not_found'
  const outcome = await applyChange(ctx, {
    action: 'claim.recheck',
    table: 'site_claims',
    id: claimId,
    applies: sql`status = 'failed'`,
    // A re-check asks for the proof again: only `claim.vouch` ever skips it.
    set: sql`status = 'pending', error = null, vouched_by = null`,
    from: sql`json_object('status', status, 'error', error, 'vouchedBy', vouched_by)`,
    to: { status: 'pending', error: null, vouchedBy: null },
  })
  if (outcome === 'done') await checkClaimSoon(ctx.deps, claimId, ctx.now)
  return outcome
}

/** A claim an operator may vouch for: not yet verified, on a blog nobody else holds. */
const VOUCHABLE = sql`status in ('pending', 'failed') and not exists (
  select 1 from sites s where s.id = site_claims.site_id
    and s.claimed_by is not null and s.claimed_by <> site_claims.user_id)`

/**
 * Vouch for a claim: its check skips only the proof (`verifyClaimJob`), and runs now. A check
 * already running read the claim before the vouch and would fail it for want of a proof, so its
 * lease is broken and the vouched check starts in its place. `taken` when someone else owns the
 * blog: a vouch never takes a blog from its owner.
 */
const vouch: ActHandler = async (ctx, id) => {
  const claimId = idOf(id)
  if (claimId === null) return 'not_found'
  const { db } = ctx.deps
  const results = await runBatch(db, [
    bumpSeq(db),
    audit(
      db,
      {
        group: ctx.group,
        actor: ctx.actor,
        action: 'claim.vouch',
        targetKind: 'claim',
        targetKey: String(claimId),
        at: ctx.now,
      },
      {
        from: sql`json_object('status', status, 'error', error, 'vouchedBy', vouched_by)`,
        to: { status: 'pending', error: null, vouchedBy: ctx.actor },
      },
      sql`from site_claims where id = ${claimId} and ${VOUCHABLE}`,
    ),
    db.all(sql`
      update site_claims set vouched_by = ${ctx.actor}, status = 'pending', error = null,
        seq = ${currentSeq}
      where id = ${claimId} and ${VOUCHABLE}
      returning id
    `),
    breakLease(db, 'site.claim', claimId, stamped('site_claims', claimId)),
    db.all(sql`
      select (s.claimed_by is not null and s.claimed_by <> c.user_id) as taken
      from site_claims c join sites s on s.id = c.site_id where c.id = ${claimId}
    `),
  ])
  if (returned(results[2]).length > 0) {
    await checkClaimSoon(ctx.deps, claimId, ctx.now)
    return 'done'
  }
  const found = returned(results[4])[0] as { taken: number } | undefined
  if (!found) return 'not_found'
  return found.taken === 1 ? 'taken' : 'not_applicable'
}

/**
 * Reject a claim with the reason its claimant will read. A check in flight is cut off, so it
 * cannot verify the claim after the operator said no; the claimant may still ask again.
 */
const reject: ActHandler = async (ctx, id, args) => {
  const claimId = idOf(id)
  if (claimId === null) return 'not_found'
  const reason = args.reason?.trim()
  if (!reason) return 'invalid'
  return applyChange(ctx, {
    action: 'claim.reject',
    table: 'site_claims',
    id: claimId,
    applies: sql`status in ('pending', 'failed')`,
    set: sql`status = 'failed', error = ${reason}, reviewed_at = ${ctx.now}, vouched_by = null`,
    from: sql`json_object('status', status, 'error', error, 'reviewedAt', reviewed_at,
      'vouchedBy', vouched_by)`,
    to: { status: 'failed', error: reason, reviewedAt: ctx.now, vouchedBy: null },
    after: (db) => [breakLease(db, 'site.claim', claimId, stamped('site_claims', claimId))],
  })
}

/** In the review queue: failed, and not reviewed since it last failed. */
const IN_REVIEW = sql`status = 'failed'
  and (reviewed_at is null or reviewed_at < last_checked_at)`

/**
 * Take a failed claim out of the review queue without deciding it. Its next failure brings it
 * back. The review stamp is the console's alone, so nothing syncs.
 */
const dismiss: ActHandler = async (ctx, id) => {
  const claimId = idOf(id)
  if (claimId === null) return 'not_found'
  return applyChange(ctx, {
    action: 'claim.dismiss',
    table: 'site_claims',
    id: claimId,
    applies: IN_REVIEW,
    set: sql`reviewed_at = ${ctx.now}`,
    from: sql`json_object('reviewedAt', reviewed_at)`,
    to: { reviewedAt: ctx.now },
    synced: false,
  })
}

const restoreReview = restoreColumns({
  table: 'site_claims',
  columns: { reviewedAt: 'reviewed_at' },
  synced: false,
})

/** What a site's listing becomes once it has no owner (over `sites`, aliased `prefix`). */
const listingUnclaimed = (prefix: string) => {
  const column = (name: string) => sql.raw(`${prefix}${name}`)
  return sql`(case when ${column('listing')} = 'listed' then
    (case when ${column('reader_count')} >= ${COMMUNITY_LISTING_MIN_READERS} then 'listed'
      else 'private' end)
    else ${column('listing')} end)`
}

type RemovedFrom = {
  claim?: { status?: string; error?: string | null; reviewedAt?: number | null }
  site?: {
    id?: number
    claimedBy?: string | null
    claimedAt?: number | null
    declaredFeedUrls?: unknown
    translationOptOut?: number
    listing?: SiteListing
  }
}
type RemovedTo = { site?: { listing?: SiteListing } }

/**
 * Remove a verified claim (ADR 0011's support action): the claim fails with a reason its claimant
 * sees, never deleted, since a device drops only what a tombstone names and claims have none. The
 * blog loses its owner and what came with one: the feeds it declared, the owner's translation
 * opt-out, and a listing only the claim opened (a featured or hidden blog stays as it is). Its
 * feeds stay where they are: an unclaimed blog carries every feed that names it.
 */
const remove: ActHandler = async (ctx, id) => {
  const claimId = idOf(id)
  if (claimId === null) return 'not_found'
  const { db } = ctx.deps
  const claim = await first<{ site_id: number; user_id: string; status: string }>(
    db,
    sql`select site_id, user_id, status from site_claims where id = ${claimId}`,
  )
  if (!claim) return 'not_found'
  if (claim.status !== 'verified') return 'not_applicable'
  const applied = stamped('site_claims', claimId)
  const results = await runBatch(db, [
    bumpSeq(db),
    audit(
      db,
      {
        group: ctx.group,
        actor: ctx.actor,
        action: 'claim.remove',
        targetKind: 'claim',
        targetKey: String(claimId),
        at: ctx.now,
      },
      {
        from: sql`json_object(
          'claim', json_object('status', c.status, 'error', c.error, 'reviewedAt', c.reviewed_at),
          'site', json_object('id', s.id, 'claimedBy', s.claimed_by, 'claimedAt', s.claimed_at,
            'declaredFeedUrls', json(s.declared_feed_urls),
            'translationOptOut', s.translation_opt_out, 'listing', s.listing))`,
        to: sql`json_object(
          'claim', json_object('status', 'failed', 'error', ${CLAIM_REMOVED_ERROR},
            'reviewedAt', ${ctx.now}),
          'site', json_object('claimedBy', null, 'listing', ${listingUnclaimed('s.')}))`,
      },
      sql`from site_claims c join sites s on s.id = c.site_id
        where c.id = ${claimId} and c.status = 'verified'`,
    ),
    db.all(sql`
      update site_claims set status = 'failed', error = ${CLAIM_REMOVED_ERROR},
        reviewed_at = ${ctx.now}, vouched_by = null, seq = ${currentSeq}
      where id = ${claimId} and status = 'verified'
      returning id
    `),
    db.run(sql`
      update sites set claimed_by = null, claimed_at = null, declared_feed_urls = '[]',
        translation_opt_out = 0, listing = ${listingUnclaimed('')}, updated_at = ${ctx.now},
        seq = ${currentSeq}
      where id = ${claim.site_id} and claimed_by = ${claim.user_id} and ${applied}
    `),
    breakLease(db, 'site.claim', claimId, applied),
  ])
  return returned(results[2]).length > 0 ? 'done' : 'not_applicable'
}

/**
 * Give a removed claim its blog back, while the blog has had no owner since and the claim is
 * still the one the operator removed. What an operator or the doors chose for the blog since is
 * kept: its listing, and a translation pause (removal cleared the owner's; a pause set after it
 * is a later choice, which the undo's guard cannot see, since it is the site's and not the
 * claim's).
 */
const LISTING_ACTIONS = actionsWriting('listing')
const TRANSLATION_ACTIONS = actionsWriting('translation')

const restoreRemoved: Inverse = (db: TelaDb, change, now) => {
  const claimId = Number(change.targetKey)
  const from = (change.from ?? {}) as RemovedFrom
  const to = (change.to ?? {}) as RemovedTo
  const site = from.site ?? {}
  const siteId = site.id ?? 0
  const still: SQL = sql`exists (
    select 1 from site_claims c join sites s on s.id = c.site_id
    where c.id = ${claimId} and s.id = ${siteId} and c.status = 'failed'
      and c.error = ${CLAIM_REMOVED_ERROR} and s.claimed_by is null)`
  const declared = JSON.stringify(Array.isArray(site.declaredFeedUrls) ? site.declaredFeedUrls : [])
  // An operator who set the blog's listing or translation since (paused it and allowed it again,
  // hid it and restored it) made a later choice its values cannot show: keep that one as it is.
  // Each is asked about on its own: Fetch now, or a pause, says nothing of the listing.
  const listingSince = laterActionOn('site', String(siteId), change.auditId, LISTING_ACTIONS)
  const translationSince = laterActionOn(
    'site',
    String(siteId),
    change.auditId,
    TRANSLATION_ACTIONS,
  )
  return {
    changed: sql`not ${still}`,
    restore: [
      db.run(sql`
        update site_claims set status = ${from.claim?.status ?? 'verified'},
          error = ${from.claim?.error ?? null}, reviewed_at = ${from.claim?.reviewedAt ?? null},
          seq = ${currentSeq}
        where id = ${claimId} and ${still}
      `),
      db.run(sql`
        update sites set claimed_by = ${site.claimedBy ?? null},
          claimed_at = ${site.claimedAt ?? null}, declared_feed_urls = ${declared},
          translation_opt_out = case when ${translationSince} then translation_opt_out
            when translation_opt_out = 0 then ${site.translationOptOut ?? 0}
            else translation_opt_out end,
          listing = case when ${listingSince} then listing
            when listing = ${to.site?.listing ?? null} then ${site.listing ?? 'private'}
            else listing end,
          updated_at = ${now}, seq = ${currentSeq}
        where id = ${siteId} and claimed_by is null and ${stamped('site_claims', claimId)}
      `),
    ],
    synced: true,
  }
}

export const claimActions = {
  'claim.recheck': recheck,
  'claim.vouch': vouch,
  'claim.reject': reject,
  'claim.dismiss': dismiss,
  'claim.remove': remove,
} satisfies Partial<Record<AdminActionName, ActHandler>>

export const claimInverses = {
  'claim.dismiss': restoreReview,
  'claim.remove': restoreRemoved,
} satisfies Partial<Record<AdminActionName, Inverse>>

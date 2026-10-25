/**
 * What an operator does about a claim (ADRs 0011, 0039): check it again, vouch for it, reject it
 * with a reason the claimant reads, take it out of the review queue, or remove a verified one. A
 * claim's row syncs to its claimant, so they see each of these on their own device.
 */
import {
  audit,
  bumpSeq,
  currentSeq,
  first,
  laterActionOn,
  listingUnclaimed,
  releaseClaim,
  type TelaDb,
} from '@tela/data'
import type { SiteListing } from '@tela/shared'
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
 * cannot verify the claim after the operator said no; the claimant may still ask again, and from
 * then on only the tag or `rel="me"` proves it (`overruled_at`, ADR 0045).
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
    set: sql`status = 'failed', error = ${reason}, reviewed_at = ${ctx.now}, vouched_by = null,
      overruled_at = ${ctx.now}`,
    from: sql`json_object('status', status, 'error', error, 'reviewedAt', reviewed_at,
      'vouchedBy', vouched_by, 'overruledAt', overruled_at)`,
    to: {
      status: 'failed',
      error: reason,
      reviewedAt: ctx.now,
      vouchedBy: null,
      overruledAt: ctx.now,
    },
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

type RemovedFrom = {
  claim?: {
    status?: string
    error?: string | null
    reviewedAt?: number | null
    overruledAt?: number | null
  }
  site?: {
    id?: number
    claimedBy?: string | null
    claimedAt?: number | null
    declaredFeedUrls?: unknown
    translationOptOut?: number
    feedOnly?: number
    listing?: SiteListing
  }
}
type RemovedTo = { site?: { listing?: SiteListing } }

/**
 * Remove a verified claim (ADR 0011's support action), through `releaseClaim` (ADR 0058), which a
 * claimant's own release shares: the claim fails with a reason its claimant
 * sees, never deleted, since a device drops only what a tombstone names and claims have none. The
 * blog loses its owner and what came with one: the feeds it declared, the owner's translation
 * opt-out, and a listing only the claim opened (a featured or hidden blog stays as it is). Its
 * feeds stay where they are: an unclaimed blog carries every feed that names it. The claimant may
 * ask again, and then only the tag or `rel="me"` proves it (`overruled_at`, ADR 0045): a plain
 * link, which is how a blog is taken by someone it only links to, won it the first time.
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
          'claim', json_object('status', c.status, 'error', c.error, 'reviewedAt', c.reviewed_at,
            'overruledAt', c.overruled_at),
          'site', json_object('id', s.id, 'claimedBy', s.claimed_by, 'claimedAt', s.claimed_at,
            'declaredFeedUrls', json(s.declared_feed_urls),
            'translationOptOut', s.translation_opt_out, 'feedOnly', s.feed_only,
            'listing', s.listing))`,
        to: sql`json_object(
          'claim', json_object('status', 'failed', 'error', ${CLAIM_REMOVED_ERROR},
            'reviewedAt', ${ctx.now}, 'overruledAt', ${ctx.now}),
          'site', json_object('claimedBy', null, 'listing', ${listingUnclaimed('s.')}))`,
      },
      sql`from site_claims c join sites s on s.id = c.site_id
        where c.id = ${claimId} and c.status = 'verified'`,
    ),
    // The claim, then its blog and any check in flight, as a claimant's own release does, with
    // the opt-out taken back and the claim overruled: only an operator's removal does that.
    ...releaseClaim(db, { claimId, by: 'operator', now: ctx.now }),
  ])
  return returned(results[2]).length > 0 ? 'done' : 'not_applicable'
}

/**
 * Give a removed claim its blog back, while the blog has had no owner since and the claim is
 * still the one the operator removed. What an operator or the doors chose for the blog since is
 * kept: its listing, and a translation pause (removal cleared the owner's; a pause set after it
 * is a later choice, which the undo's guard cannot see, since it is the site's and not the
 * claim's). Not for Discover is no such choice: it writes the review alone, and changes no listing
 * (ADR 0041).
 */
const LISTING_ACTIONS = actionsWriting('listing')
const TRANSLATION_ACTIONS = actionsWriting('translation')
const FEED_ONLY_ACTIONS = actionsWriting('feedOnly')

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
  const feedOnlySince = laterActionOn('site', String(siteId), change.auditId, FEED_ONLY_ACTIONS)
  return {
    changed: sql`not ${still}`,
    restore: [
      db.run(sql`
        update site_claims set status = ${from.claim?.status ?? 'verified'},
          error = ${from.claim?.error ?? null}, reviewed_at = ${from.claim?.reviewedAt ?? null},
          overruled_at = ${from.claim?.overruledAt ?? null}, seq = ${currentSeq}
        where id = ${claimId} and ${still}
      `),
      db.run(sql`
        update sites set claimed_by = ${site.claimedBy ?? null},
          claimed_at = ${site.claimedAt ?? null}, declared_feed_urls = ${declared},
          translation_opt_out = case when ${translationSince} then translation_opt_out
            when translation_opt_out = 0 then ${site.translationOptOut ?? 0}
            else translation_opt_out end,
          feed_only = case when ${feedOnlySince} then feed_only
            when feed_only = 0 then ${site.feedOnly ?? 0}
            else feed_only end,
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

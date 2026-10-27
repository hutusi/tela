/**
 * Leaving Tela (ADR 0058): closing an account, and letting a claimed blog go.
 *
 * Closing is two phases. `closeAccount` is one batch, run the moment the member (or an operator)
 * closes it: it empties everything anyone else can see or reach of the account, ends every way in,
 * and marks the profile closed, so every device that names the member is refused from its next
 * call. `member.erase` (tela-jobs, `queries/erase.ts`) then removes, in fenced chunks, what only
 * the member's own devices held, once no signed copy of their session can still be read.
 *
 * Neither phase deletes the `user` or `profiles` row. They stay as anonymized shells for good: the
 * handle stays taken (the unique index answers anyone who asks for it), so nobody can take it to
 * pass as the member, and other members' rows that name the account (an invitation they joined
 * by, a follow, an audit row) stay valid without a cascade taking them along.
 *
 * Every statement here works on sets selected by the member's id, never on lists of ids read
 * first, so it binds a handful of parameters however much the member had (D1's 100, AGENTS.md).
 */
import type { Blobs } from '@tela/platform'
import { COMMUNITY_LISTING_MIN_READERS } from '@tela/shared'
import { CLAIM_CLOSED_ERROR, CLAIM_RELEASED_ERROR, CLAIM_REMOVED_ERROR } from '@tela/shared/admin'
import { type SQL, sql } from 'drizzle-orm'
import type { TelaDb } from '../db'
import { isFenceRefusal } from '../leases'
import { bumpSeq, currentSeq } from '../seq'
import { audit, newGroupId } from './admin'
import { endConnections } from './apps'
import { withdrawBodyRequests } from './translation'

type Statement = ReturnType<TelaDb['run']>

// ---------------------------------------------------------------------------------------------
// Releasing a claim

/**
 * Who let a claimed blog go: an operator removing the claim (`claim.remove`), the claimant from
 * their Dashboard, or the claimant's account closing.
 */
export type ReleasedBy = 'operator' | 'member' | 'closure'

/** What the released claim says, by who released it: text, which every claim page shows as it is. */
export const RELEASE_ERRORS: Record<ReleasedBy, string> = {
  operator: CLAIM_REMOVED_ERROR,
  member: CLAIM_RELEASED_ERROR,
  closure: CLAIM_CLOSED_ERROR,
}

/**
 * What a site's listing becomes once it has no owner (over `sites`, aliased `prefix`): a listing
 * only the claim opened closes, and one that another door holds stays, three readers or an
 * operator's review that listed it (ADR 0041). Featured and hidden stay as they are.
 */
export function listingUnclaimed(prefix: string): SQL {
  const column = (name: string) => sql.raw(`${prefix}${name}`)
  return sql`(case when ${column('listing')} = 'listed' then
    (case when ${column('reader_count')} >= ${COMMUNITY_LISTING_MIN_READERS}
      or ${column('review')} = 'listed' then 'listed' else 'private' end)
    else ${column('listing')} end)`
}

/** Which verified claims a release is for: one claim, one member's claim on one blog, or all a member's. */
export type ReleaseTarget =
  | { claimId: number }
  | { siteId: number; userId: string }
  | { userId: string }

/**
 * Let verified claims go: each fails with the reason its claimant reads (a claim row is never
 * deleted while a device may hold it, since claims have no tombstones), and its blog loses its
 * owner and what came with one: the feeds it declared, and a listing only the claim opened. Its
 * feeds stay where they are: an unclaimed blog carries every feed that names it.
 *
 * Only an operator's removal also takes back the blog's opt-outs (translation, and only using what
 * its feed provides, ADR 0061) and marks the claim overruled (ADR 0045), so that only the tag or `rel="me"` proves it again. A claimant who lets
 * their own blog go, or whose account closes, leaves the blog as they set it: what its writer
 * chose stays chosen, and the operator can still change it from the console.
 *
 * Statements for a batch that starts with `bumpSeq`. The first is the claims' update, whose
 * `RETURNING` rows are the claims released; the blog moves only in the batch that released its
 * claim (`seq = currentSeq`, which no other batch has), and a claim check in flight is cut off.
 */
export function releaseClaim(
  db: TelaDb,
  options: ReleaseTarget & { by: ReleasedBy; now: number },
): Statement[] {
  const { by, now } = options
  const target =
    'claimId' in options
      ? sql`id = ${options.claimId}`
      : 'siteId' in options
        ? sql`site_id = ${options.siteId} and user_id = ${options.userId}`
        : sql`user_id = ${options.userId}`
  const claimant =
    'claimId' in options
      ? sql`(select user_id from site_claims where id = ${options.claimId})`
      : sql`${options.userId}`
  const operator = by === 'operator'
  const released = sql`id in (select site_id from site_claims
    where ${target} and status = 'failed' and seq = ${currentSeq})`
  return [
    db.all(sql`
      update site_claims set status = 'failed', error = ${RELEASE_ERRORS[by]},
        reviewed_at = ${now}, vouched_by = null,
        overruled_at = ${operator ? sql`${now}` : sql`overruled_at`}, seq = ${currentSeq}
      where ${target} and status = 'verified'
      returning id
    `),
    // A closing account's blogs all go, whatever its claim rows say: nobody may hold one for it.
    db.run(sql`
      update sites set claimed_by = null, claimed_at = null, declared_feed_urls = '[]',
        translation_opt_out = ${operator ? sql`0` : sql`translation_opt_out`},
        feed_only = ${operator ? sql`0` : sql`feed_only`},
        listing = ${listingUnclaimed('')}, updated_at = ${now}, seq = ${currentSeq}
      where claimed_by = ${claimant} ${by === 'closure' ? sql`` : sql`and ${released}`}
    `),
    db.run(sql`
      delete from leases where kind = 'site.claim' and key in (
        select cast(id as text) from site_claims where ${target} and seq = ${currentSeq})
    `),
  ]
}

// ---------------------------------------------------------------------------------------------
// Closing an account

/** Where every closed account's address is: RFC 6761's `.invalid`, which no mail reaches. */
const CLOSED_DOMAIN = '@deleted.invalid'

/** An address no mail reaches, unique per account as `user.email` must be. */
export const closedEmail = (userId: string) => `deleted+${userId}${CLOSED_DOMAIN}`

/**
 * Whether `email` is a closed account's address, in any case: better-auth's ids mix cases and it
 * lowercases the address it is asked for, so what is asked for seldom matches the row itself.
 */
export const isClosedEmail = (email: string) => email.toLowerCase().endsWith(CLOSED_DOMAIN)

/** How long after closing `member.erase` starts: past the five-minute signed session copy. */
export const ERASE_AFTER_MS = 10 * 60_000

export type CloseAccount = {
  userId: string
  /** Who closed it: the member, an operator, or null for a restore re-applying a closure. */
  actor: string | null
  /** The audit row's action: the member's own `account.delete`, or an operator's `member.delete`. */
  action: 'account.delete' | 'member.delete'
  group: string
  now: number
  /**
   * Refuse an admin's account, aborting the batch before it writes anything: an admin is ungranted
   * first (ADR 0058). A restore re-applying a closure does not ask: the account was closed.
   */
  refuseAdmin?: boolean
}

export type Closed = 'closed' | 'already' | 'admin' | 'not_found'

/**
 * Close an account in one batch (ADR 0058). In order:
 *
 * 1. the audit row, written only while the account is open, so a repeat logs nothing;
 * 2. the sync sequence, since most of what follows is rows devices hold;
 * 3. its follows, both ways, deleted as an unfollow is, so each follower's device drops its row;
 * 4. its notes and blogrolls, emptied and deleted, so no page shows them;
 * 5. the profile emptied (name, bio, picture, languages, both privacy switches, the console) and
 *    marked closed; the handle stays;
 * 6. every way in: sessions, the apps connected to it and their tokens (ADR 0064), passwords and
 *    providers, mailed codes and OAuth states, and Tela's own counts for the member and the
 *    address;
 * 7. its invitations: its codes revoked and their holds cancelled, and the address on the
 *    invitation it joined by replaced, so the record of who it invited, and who invited it, stays
 *    without the address; nobody else's invitation is touched;
 * 8. the address, replaced by one no mail reaches, and the name and picture better-auth keeps;
 * 9. its blogs released, and a claim still pending failed, so no check gives it one later;
 * 10. its body translations waiting to run, given back to its ledger and ended unpaid; one
 *     already running finishes and is settled as ever (`member.erase` waits for it);
 * 11. imports waiting to be added for it, and its record of posts opened (ADR 0066).
 *
 * What stays for `member.erase`: what only the member's devices held (read states, likes,
 * highlights, folders, prefs, subscriptions) and the counts others see that rest on them.
 *
 * The address is read in SQL, before the statement that replaces it, so a restore can re-apply a
 * closure from the account's id alone (`reapplyClosures`).
 */
export async function closeAccount(db: TelaDb, input: CloseAccount): Promise<Closed> {
  const { userId: id, now } = input
  const address = sql`(select email from user where id = ${id})`
  const items: Statement[] = input.refuseAdmin
    ? [
        db.run(sql`insert into lease_fence (x) select null
          where exists (select 1 from profiles where user_id = ${id} and is_admin = 1)`),
      ]
    : []
  items.push(
    audit(
      db,
      {
        group: input.group,
        actor: input.actor,
        action: input.action,
        targetKind: 'member',
        targetKey: id,
        at: now,
      },
      { from: sql`json_object('deletedAt', deleted_at)`, to: { deletedAt: now } },
      sql`from profiles where user_id = ${id} and deleted_at is null`,
    ),
    bumpSeq(db),
    // Each follower's device holds its follow of the member, with their handle and name: deleted
    // as an unfollow is, it drops it at the next pull (ADR 0031). Two statements, one per index.
    db.run(sql`
      update follows set deleted_at = ${now}, updated_at = max(updated_at, ${now}),
        seq = ${currentSeq}
      where follower_id = ${id} and deleted_at is null
    `),
    db.run(sql`
      update follows set deleted_at = ${now}, updated_at = max(updated_at, ${now}),
        seq = ${currentSeq}
      where followee_id = ${id} and deleted_at is null
    `),
    db.run(sql`
      update recommendations set note = null, deleted_at = coalesce(deleted_at, ${now}),
        updated_at = max(updated_at, ${now}), seq = ${currentSeq}
      where user_id = ${id} and (deleted_at is null or note is not null)
    `),
    // A blogroll's name must have a character (its check), so it keeps one that says nothing.
    db.run(sql`
      update blogrolls set name = '-', description = '', is_public = 0,
        public_version = public_version + 1, deleted_at = coalesce(deleted_at, ${now}),
        updated_at = max(updated_at, ${now}), seq = ${currentSeq}
      where user_id = ${id} and (deleted_at is null or name <> '-' or description <> '')
    `),
    db.run(sql`
      update blogroll_blogs set note = null, note_at = max(note_at, ${now}), seq = ${currentSeq}
      where user_id = ${id} and note is not null
    `),
  )
  // The switches go off with their clocks moved and their versions counted, as a hide does, so no
  // show queued anywhere applies over it (issue #16); the Gravatar switch too, set, since a switch
  // never set counts as on (ADR 0033). The picture's version moves, so its address is new.
  const emptied = items.length
  items.push(
    db.all(sql`
      update profiles set display_name = null, bio = null, avatar_key = null,
        avatar_version = avatar_version + 1, gravatar = 0, gravatar_at = max(gravatar_at, ${now}),
        gravatar_found = null, gravatar_checked_at = null,
        public_subscriptions = 0, public_subscriptions_at = max(public_subscriptions_at, ${now}),
        public_subscriptions_version = public_subscriptions_version + 1,
        public_likes = 0, public_likes_at = max(public_likes_at, ${now}),
        public_likes_version = public_likes_version + 1,
        ui_locale = null, reading_lang = null, is_admin = 0,
        deleted_at = ${now}, updated_at = ${now}, seq = ${currentSeq}
      where user_id = ${id} and deleted_at is null
      returning user_id
    `),
    db.run(sql`delete from session where user_id = ${id}`),
    ...endConnections(db, id, 'closed', now),
    db.run(sql`delete from account where user_id = ${id}`),
    // Codes better-auth mailed the address (`<type>-otp-<address>`, Tela's own deletion code
    // among them) and an OAuth state naming the member, which holds their address. Compared
    // exactly, never with LIKE: an address may hold `_`. A state's JSON is read only when valid.
    db.run(sql`
      delete from verification
      where (instr(identifier, '-otp-') > 0
          and substr(identifier, instr(identifier, '-otp-') + 5) = ${address})
        or (case when json_valid(value) then json_extract(value, '$.link.userId') end) = ${id}
    `),
    // `<action>:<subject>`: the member's own counts and the address's. An action never has a colon.
    db.run(sql`
      delete from action_limits where substr(key, instr(key, ':') + 1) in (${id}, ${address})
    `),
    // Holds for the address, and the holds others placed on its codes, which could never finish.
    db.run(sql`
      delete from invite_redemptions where redeemed_at is null
        and (email = ${address}
          or code in (select code from invite_codes where created_by = ${id}))
    `),
    db.run(sql`
      update invite_codes set revoked_at = ${now} where created_by = ${id} and revoked_at is null
    `),
    // The invitation it joined by keeps its place spent and its member, without the address. One
    // per code, so `(code, email)` stays unique; the operator's (`code` null) never clash.
    db.run(sql`
      update invite_redemptions set email = ${`deleted:${id}`}
      where (user_id = ${id} or email = ${address}) and email <> ${`deleted:${id}`}
    `),
    db.run(sql`
      update user set email = ${closedEmail(id)}, name = '', image = null, updated_at = ${now}
      where id = ${id} and email <> ${closedEmail(id)}
    `),
    ...releaseClaim(db, { userId: id, by: 'closure', now }),
    db.run(sql`
      update site_claims set status = 'failed', error = ${CLAIM_CLOSED_ERROR},
        reviewed_at = ${now}, vouched_by = null, seq = ${currentSeq}
      where user_id = ${id} and status = 'pending'
    `),
    db.run(sql`
      delete from leases where kind = 'site.claim'
        and key in (select cast(id as text) from site_claims where user_id = ${id})
    `),
    // Its translations not yet started, given back and ended unpaid; one running finishes.
    ...withdrawBodyRequests(db, id, now),
    db.run(sql`delete from pending_feeds where user_id = ${id}`),
    // The day's record of posts opened from blogs it did not follow (ADR 0066).
    db.run(sql`delete from post_opens where user_id = ${id}`),
    db.all(sql`select deleted_at from profiles where user_id = ${id}`),
  )
  let results: unknown[]
  try {
    results = (await db.batch(items as never)) as unknown as unknown[]
  } catch (err) {
    if (input.refuseAdmin && isFenceRefusal(err)) return 'admin'
    throw err
  }
  if ((results[emptied] as unknown[]).length > 0) return 'closed'
  return (results.at(-1) as unknown[]).length > 0 ? 'already' : 'not_found'
}

// ---------------------------------------------------------------------------------------------
// Closures in the blob store

/**
 * Where each closure is recorded, outside the database (ADR 0058): a backup restored after an
 * account was closed brings the account back, and the restore runbook re-applies every closure
 * here. Only the account's id and when, which say nothing about the member.
 */
export const CLOSURES_PREFIX = 'closures/'

export const closureKey = (userId: string) => `${CLOSURES_PREFIX}${userId}`

/** Record a closure. Written before the closing batch, so a closing that fails is re-applied. */
export async function writeClosure(blobs: Blobs, userId: string, at: number): Promise<void> {
  await blobs.put(closureKey(userId), JSON.stringify({ id: userId, at }), {
    contentType: 'application/json',
  })
}

/**
 * Close again every account a closure names (`closeAccount`, at the time it was closed), after a
 * restore from a backup older than some of them. An account already closed, or one the backup
 * never had, changes nothing. Returns how many closures were read and how many accounts closed.
 */
export async function reapplyClosures(
  db: TelaDb,
  blobs: Blobs,
  now: number,
): Promise<{ closures: number; closed: number }> {
  let closures = 0
  let closed = 0
  let cursor: string | undefined
  do {
    const page = await blobs.list({ prefix: CLOSURES_PREFIX, ...(cursor ? { cursor } : {}) })
    for (const key of page.keys) {
      const userId = key.slice(CLOSURES_PREFIX.length)
      if (!userId || userId.includes('/')) continue
      closures++
      const stored = await blobs.get(key)
      const at = stored ? closedAt(await stored.text()) : null
      const outcome = await closeAccount(db, {
        userId,
        actor: null,
        action: 'account.delete',
        group: newGroupId(),
        now: at ?? now,
      })
      if (outcome === 'closed') closed++
    }
    cursor = page.cursor ?? undefined
  } while (cursor)
  return { closures, closed }
}

function closedAt(text: string): number | null {
  try {
    const at = (JSON.parse(text) as { at?: unknown }).at
    return typeof at === 'number' && Number.isSafeInteger(at) && at > 0 ? at : null
  } catch {
    return null
  }
}

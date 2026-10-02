/**
 * Invite codes (ADR 0034): a hold beside a code, the claim that admits a new account, the
 * settlement once it exists, and a member's five. Every decision about a place is one statement
 * read back through RETURNING, because D1 has no transaction to hold between a count and the
 * write it allows: two joins at once cannot both take a code's last place, nor two requests a
 * member's sixth code.
 *
 * A code's places are its redeemed rows. A hold (a row not yet redeemed) takes none, so a typo, a
 * stranger with the link or a run of junk joins never fills a code. Codes arrive normalized
 * (`normalizeInviteCode`); addresses are lowercased here, as better-auth stores `user.email`.
 */
import { INVITE_ALLOWANCE, INVITE_ALPHABET, INVITE_CODE_LENGTH } from '@tela/shared'
import { sql } from 'drizzle-orm'
import type { TelaDb } from '../db'
import { first } from '../first'

const HOUR = 3600_000
const DAY = 24 * HOUR
/** How long a join holds its address beside a code: a day, against the mailed code's hour. */
export const JOIN_HOLD_MS = DAY
/**
 * How long the operator's invitation to one address waits: the admin route creates the account
 * straight after writing it.
 */
export const OPERATOR_INVITE_MS = HOUR

/** A code, aliased `c`, that can admit someone new: not revoked, and not every place taken. */
const open = sql.raw(`c.revoked_at is null and (select count(*) from invite_redemptions x
  where x.code = c.code and x.redeemed_at is not null) < c.max_uses`)

/** A member's code, aliased `c`, that counts toward their five: unrevoked, or used for good. */
const counted = sql.raw(`(c.revoked_at is null or exists (select 1 from invite_redemptions x
  where x.code = c.code and x.redeemed_at is not null))`)

const account = (email: string) => sql`exists (select 1 from user u where u.email = ${email})`

/**
 * The rows, aliased `r`, a code sign-in or the admin route may admit `email` by: its own
 * invitation from the operator, or a live hold on a code that still has room. A row already
 * claimed but never settled is one whose user insert failed after the claim, and it admits the
 * same address again without spending a second place. A provider's sign-in never comes here: it
 * is admitted only by the code it carried (`claimByCode`).
 */
const admits = (email: string, now: number) => sql`
  r.email = ${email} and not ${account(email)} and (
    (r.redeemed_at is not null and r.settled_at is null)
    or (r.redeemed_at is null and r.expires_at > ${now} and (r.code is null
      or exists (select 1 from invite_codes c where c.code = r.code and ${open})))
  )`

/** What `/api/v1/join` answers: 200 for a hold or a member, 400 for `invalid`, 409 for `used`. */
export type JoinOutcome =
  /** The address may now ask for a code, which says it is invited. */
  | 'held'
  /**
   * The address has an account: an ordinary sign-in code. It takes neither a hold nor a place from
   * the code it brought.
   */
  | 'member'
  /** No such code, or a revoked one: one answer for both. */
  | 'invalid'
  /** Every place is taken. A member is told so too, so the answer says nothing of who is one. */
  | 'used'

/**
 * A code's places while it is not revoked, which set the join's limit on it; null for an unknown or
 * revoked code, which a join refuses before it spends any count but the client's own. A full code
 * has its places all the same: `holdJoin` says it is used.
 */
export async function livePlaces(db: TelaDb, code: string): Promise<number | null> {
  const row = await first<{ max_uses: number }>(
    db,
    sql`select max_uses from invite_codes where code = ${code} and revoked_at is null`,
  )
  return row?.max_uses ?? null
}

/**
 * Hold `email` beside `code` for a day (ADR 0034). The hold takes no place; a repeated join
 * refreshes it. On a single-use code the later join moves the hold, so only the last address
 * asked for can finish. Nothing is written for an address that has an account, but its join
 * moves the hold all the same: a hold of one's own that outlived a join with another address
 * would tell that the other address has an account.
 */
export async function holdJoin(
  db: TelaDb,
  input: { code: string; email: string; now: number },
): Promise<JoinOutcome> {
  const { code, now } = input
  const email = input.email.toLowerCase()
  const [, , state] = await db.batch([
    db.run(sql`
      insert into invite_redemptions (code, email, expires_at, created_at)
      select c.code, ${email}, ${now + JOIN_HOLD_MS}, ${now} from invite_codes c
      where c.code = ${code} and ${open} and not ${account(email)}
      on conflict (code, email) do update set expires_at = excluded.expires_at
      where invite_redemptions.redeemed_at is null
    `),
    // Whoever asked: on an open code the insert above always leaves a newcomer a live hold, and a
    // member's join must move the others' just the same.
    db.run(sql`
      delete from invite_redemptions
      where code = ${code} and email <> ${email} and redeemed_at is null
        and exists (select 1 from invite_codes c where c.code = ${code} and c.max_uses = 1 and ${open})
    `),
    db.all<{ live: number; room: number; member: number; pending: number; again: number }>(sql`
      select c.revoked_at is null as live,
        (select count(*) from invite_redemptions x
          where x.code = c.code and x.redeemed_at is not null) < c.max_uses as room,
        ${account(email)} as member,
        exists (select 1 from invite_redemptions r where r.code = c.code and r.email = ${email}
          and r.redeemed_at is null and r.expires_at > ${now}) as pending,
        exists (select 1 from invite_redemptions r where r.code = c.code and r.email = ${email}
          and r.redeemed_at is not null and r.settled_at is null) as again
      from invite_codes c where c.code = ${code}
    `),
  ])
  const row = state[0]
  if (!row?.live) return 'invalid'
  if (row.member) return row.room ? 'member' : 'used'
  if (row.again || (row.room && row.pending)) return 'held'
  return 'used'
}

/**
 * The operator's invitation to one address (`bun run admin invite`), written just before the
 * admin route creates the account, whose gate then claims it like anyone's.
 */
export async function inviteAddress(
  db: TelaDb,
  input: { email: string; now: number },
): Promise<void> {
  await db.run(sql`
    insert into invite_redemptions (code, email, expires_at, created_at)
    values (null, ${input.email.toLowerCase()}, ${input.now + OPERATOR_INVITE_MS}, ${input.now})
  `)
}

/**
 * Whether `email`, which has no account, may be sent a sign-in code (the mail gate): it holds a
 * row that `claimInvite` would admit it by.
 */
export async function holdsInvite(
  db: TelaDb,
  input: { email: string; now: number },
): Promise<boolean> {
  const email = input.email.toLowerCase()
  const row = await first<{ held: number }>(
    db,
    sql`select exists (select 1 from invite_redemptions r where ${admits(email, input.now)}) as held`,
  )
  return Boolean(row?.held)
}

export type InviteClaim = { id: number; code: string | null }

/**
 * Admit a new account for `email` at a code sign-in or from the admin route: redeem the best row
 * it holds, in one statement. A row already claimed comes first, so a retry spends nothing more;
 * then the operator's invitation; then the newest hold. Null when nothing admits it.
 */
export async function claimInvite(
  db: TelaDb,
  input: { email: string; now: number },
): Promise<InviteClaim | null> {
  const email = input.email.toLowerCase()
  const rows = await db.all<InviteClaim>(sql`
    update invite_redemptions set redeemed_at = coalesce(redeemed_at, ${input.now})
    where id = (
      select r.id from invite_redemptions r where ${admits(email, input.now)}
      order by r.redeemed_at is null, r.code is not null, r.created_at desc, r.id desc
      limit 1
    )
    returning id, code
  `)
  return rows[0] ?? null
}

/**
 * Why `claimInvite` admitted nothing for `email`: true when it still has a live hold, which can
 * only be on a code whose places others took since its code was mailed (revoking a code deletes its
 * holds). The gate then says the code is used up, rather than that an invitation is needed.
 */
export async function waitsOnFullCode(
  db: TelaDb,
  input: { email: string; now: number },
): Promise<boolean> {
  const row = await first<{ held: number }>(
    db,
    sql`select exists (select 1 from invite_redemptions r where r.email = ${input.email.toLowerCase()}
      and r.code is not null and r.redeemed_at is null and r.expires_at > ${input.now}) as held`,
  )
  return Boolean(row?.held)
}

/**
 * Admit a new account for `email` by the code its provider sign-in carried (ADR 0036): the
 * address's row for that code redeemed, or, when it has none, a redeemed row written, in one
 * statement guarded like a join by the code's room. An address that already claimed a row whose
 * account never came (a failed create, or a code sign-in racing this one) is admitted by that row
 * again, on whichever code, and spends nothing more: by its own code when the row is on it, else
 * only while the code carried has room, so the sign-in is admitted exactly when the code alone
 * would admit it.
 */
export async function claimByCode(
  db: TelaDb,
  input: { code: string; email: string; now: number },
): Promise<InviteClaim | null> {
  const { code, now } = input
  const email = input.email.toLowerCase()
  const claimed = sql`r.email = ${email} and r.redeemed_at is not null and r.settled_at is null`
  const [before, written] = await db.batch([
    db.all<InviteClaim>(sql`
      select r.id, r.code from invite_redemptions r
      where ${claimed} and not ${account(email)} and (r.code = ${code}
        or exists (select 1 from invite_codes c where c.code = ${code} and ${open}))
      order by r.id limit 1
    `),
    db.all<InviteClaim>(sql`
      insert into invite_redemptions (code, email, expires_at, redeemed_at, created_at)
      select c.code, ${email}, ${now}, ${now}, ${now} from invite_codes c
      where c.code = ${code} and ${open} and not ${account(email)}
        and not exists (select 1 from invite_redemptions r where ${claimed})
      on conflict (code, email) do update set redeemed_at = excluded.redeemed_at
        where invite_redemptions.redeemed_at is null
      returning id, code
    `),
  ])
  return written[0] ?? before[0] ?? null
}

/**
 * Once the account exists: record the member on what admitted them, and when, which ends its
 * re-admission for good, and delete every hold the address still had, on any code. Returns the
 * rows settled.
 */
export async function settleInvite(
  db: TelaDb,
  input: { email: string; userId: string; now: number },
): Promise<InviteClaim[]> {
  const email = input.email.toLowerCase()
  const [settled] = await db.batch([
    db.all<InviteClaim>(sql`
      update invite_redemptions set user_id = ${input.userId}, settled_at = ${input.now}
      where email = ${email} and redeemed_at is not null and settled_at is null
      returning id, code
    `),
    db.run(sql`delete from invite_redemptions where email = ${email} and redeemed_at is null`),
  ])
  return settled
}

/**
 * A member's code: `INVITE_CODE_LENGTH` symbols of `INVITE_ALPHABET` from the platform's CSPRNG.
 * A byte at or above the largest multiple of the alphabet's size is drawn again, so every symbol
 * is equally likely.
 */
export function drawMemberCode(): string {
  const size = INVITE_ALPHABET.length
  const below = 256 - (256 % size)
  const symbols: string[] = []
  while (symbols.length < INVITE_CODE_LENGTH) {
    for (const byte of crypto.getRandomValues(new Uint8Array(INVITE_CODE_LENGTH * 2))) {
      if (byte < below) symbols.push(INVITE_ALPHABET.charAt(byte % size))
    }
  }
  return symbols.slice(0, INVITE_CODE_LENGTH).join('')
}

/** A new member code, or why there is none: `clash` is worth a fresh draw, `allowance` is not. */
export type NewMemberCode =
  | { ok: true; code: string }
  | { ok: false; reason: 'clash' | 'allowance' }

/**
 * Write a code for `userId` while fewer than `INVITE_ALLOWANCE` of theirs count (unrevoked, or
 * used), in one statement, so two requests at once cannot make a sixth.
 */
export async function createMemberCode(
  db: TelaDb,
  input: { userId: string; now: number; code?: string },
): Promise<NewMemberCode> {
  const { userId, now } = input
  const code = input.code ?? drawMemberCode()
  const ofMember = sql`from invite_codes c where c.created_by = ${userId} and ${counted}`
  const [inserted, counts] = await db.batch([
    db.all<{ code: string }>(sql`
      insert into invite_codes (code, created_by, max_uses, created_at)
      select ${code}, ${userId}, 1, ${now} where (select count(*) ${ofMember}) < ${INVITE_ALLOWANCE}
      on conflict (code) do nothing
      returning code
    `),
    db.all<{ n: number }>(sql`select count(*) as n ${ofMember}`),
  ])
  if (inserted[0]) return { ok: true, code: inserted[0].code }
  return { ok: false, reason: (counts[0]?.n ?? 0) < INVITE_ALLOWANCE ? 'clash' : 'allowance' }
}

/** Delete the holds on `code` once it is revoked; they can never be claimed. */
const cancelHolds = (db: TelaDb, code: string) =>
  db.run(sql`
    delete from invite_redemptions where code = ${code} and redeemed_at is null
      and exists (select 1 from invite_codes c where c.code = ${code} and c.revoked_at is not null)
  `)

/**
 * Revoke a member's own code while nobody has joined with it, which frees its place among their
 * five and cancels its holds. False for a code that is not theirs, already revoked, or used.
 */
export async function revokeCode(
  db: TelaDb,
  input: { code: string; userId: string; now: number },
): Promise<boolean> {
  const [revoked] = await db.batch([
    db.all(sql`
      update invite_codes set revoked_at = ${input.now}
      where code = ${input.code} and created_by = ${input.userId} and revoked_at is null
        and not exists (select 1 from invite_redemptions x
          where x.code = invite_codes.code and x.redeemed_at is not null)
      returning code
    `),
    cancelHolds(db, input.code),
  ])
  return revoked.length > 0
}

export type MemberCode = {
  code: string
  createdAt: number
  /** When someone joined with it; null while it is unused. */
  joinedAt: number | null
  /** Who joined, once their account exists. A pending address is never shown. */
  handle: string | null
}

/** The codes that count toward a member's five, oldest first. */
export async function listMemberCodes(db: TelaDb, userId: string): Promise<MemberCode[]> {
  const rows = await db.all<{
    code: string
    created_at: number
    joined_at: number | null
    handle: string | null
  }>(sql`
    select c.code, c.created_at, r.redeemed_at as joined_at, p.handle
    from invite_codes c
    left join invite_redemptions r on r.id = (select x.id from invite_redemptions x
      where x.code = c.code and x.redeemed_at is not null order by x.redeemed_at, x.id limit 1)
    left join profiles p on p.user_id = r.user_id
    where c.created_by = ${userId} and ${counted}
    order by c.created_at, c.code
  `)
  return rows.map((r) => ({
    code: r.code,
    createdAt: r.created_at,
    joinedAt: r.joined_at,
    handle: r.handle,
  }))
}

/**
 * The operator's code of their own text (`bun run admin code`), with `maxUses` places. False when
 * the code exists already, whoever made it.
 */
export async function createOperatorCode(
  db: TelaDb,
  input: { code: string; maxUses: number; now: number },
): Promise<boolean> {
  const rows = await db.all(sql`
    insert into invite_codes (code, created_by, max_uses, created_at)
    values (${input.code}, null, ${input.maxUses}, ${input.now})
    on conflict (code) do nothing
    returning code
  `)
  return rows.length > 0
}

export type OperatorCode = {
  code: string
  maxUses: number
  /** Places taken: people who joined with it. */
  uses: number
  /** Live holds: addresses that asked to join with it and have not yet signed in. */
  holds: number
  createdAt: number
  revokedAt: number | null
}

/** Every operator code, oldest first. */
export async function listOperatorCodes(db: TelaDb, now: number): Promise<OperatorCode[]> {
  const rows = await db.all<{
    code: string
    max_uses: number
    uses: number
    holds: number
    created_at: number
    revoked_at: number | null
  }>(sql`
    select c.code, c.max_uses, c.created_at, c.revoked_at,
      (select count(*) from invite_redemptions r
        where r.code = c.code and r.redeemed_at is not null) as uses,
      (select count(*) from invite_redemptions r
        where r.code = c.code and r.redeemed_at is null and r.expires_at > ${now}) as holds
    from invite_codes c where c.created_by is null
    order by c.created_at, c.code
  `)
  return rows.map((r) => ({
    code: r.code,
    maxUses: r.max_uses,
    uses: r.uses,
    holds: r.holds,
    createdAt: r.created_at,
    revokedAt: r.revoked_at,
  }))
}

/**
 * Withdraw an operator code (`bun run admin revoke`), used or not: nobody else joins with it, and
 * its holds are cancelled. Those who joined keep their accounts. False for an unknown, revoked or
 * member's code.
 */
export async function revokeOperatorCode(
  db: TelaDb,
  input: { code: string; now: number },
): Promise<boolean> {
  const [revoked] = await db.batch([
    db.all(sql`
      update invite_codes set revoked_at = ${input.now}
      where code = ${input.code} and created_by is null and revoked_at is null
      returning code
    `),
    cancelHolds(db, input.code),
  ])
  return revoked.length > 0
}

/**
 * For the daily batch: holds a day past their expiry, whose addresses never became members, so
 * they are not kept (or exported) for good.
 */
export function pruneInvites(db: TelaDb, now: number) {
  return db.all<{ id: number }>(sql`
    delete from invite_redemptions where redeemed_at is null and expires_at < ${now - DAY}
    returning id
  `)
}

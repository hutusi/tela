/**
 * Invitations (ADR 0034, 0039): every code, the operator's and members', the holds waiting on
 * them, and what the operator may do with each. An invitation is a code, not a mail: there is no
 * "opened", and "waiting" means a live hold, an address that asked to join and has not yet signed
 * in.
 *
 * Each write is one batch with its audit row, so its statements are written out here rather than
 * called from `@tela/data`, whose `createOperatorCode`, `revokeOperatorCode` and `revokeCode`
 * commit batches of their own. They keep those functions' conditions: a member's code is revoked
 * only while nobody has joined with it, and revoking any code deletes its holds. An audit row never
 * holds an address: a hold is named by its redemption id.
 */
import { audit, historyOf, type TelaDb } from '@tela/data'
import { INVITE_ALLOWANCE, isOperatorCode, normalizeInviteCode } from '@tela/shared'
import {
  ADMIN_LIST_LIMIT,
  type AdminActionName,
  type AdminCodeRow,
  type AdminHoldRow,
  type AdminInviteDetail,
  type AdminList,
  type AdminPerson,
  isAdminFilter,
} from '@tela/shared/admin'
import { type SQL, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import type { ApiDeps } from '../../../deps'
import { inviteMember } from '../../invite-member'
import { likePattern } from '../../members'
import { type ActHandler, type AdminEnv, type Inverse, returned, runBatch } from '../framework'

/** An operator code's places, as the schema checks them. */
const MAX_USES = 100_000

const CODE_ID = 'code:'
const HOLD_ID = 'hold:'

/** The stored code a row id names (`code:<CODE>`), or null. */
export function codeOf(id: string): string | null {
  if (!id.startsWith(CODE_ID)) return null
  const code = id.slice(CODE_ID.length)
  return normalizeInviteCode(code) === code ? code : null
}

/** The redemption a row id names (`hold:<n>`), or null. */
export function holdOf(id: string): number | null {
  if (!id.startsWith(HOLD_ID)) return null
  const raw = id.slice(HOLD_ID.length)
  const n = Number(raw)
  return Number.isSafeInteger(n) && n > 0 && String(n) === raw ? n : null
}

/** Over a code aliased `alias`: whether anyone has joined with it. */
const used = (alias: string) =>
  sql.raw(`exists (select 1 from invite_redemptions x
    where x.code = ${alias}.code and x.redeemed_at is not null)`)

/**
 * Over a code aliased `alias`: whether it may be open without its maker holding more than five
 * that count (unrevoked, or used for good; ADR 0034). Always for the operator's. Restoring a
 * member's revoked code would otherwise give back a place they spent on another code since.
 */
const room = (alias: string) =>
  sql.raw(`(${alias}.created_by is null or (select count(*) from invite_codes o
    where o.created_by = ${alias}.created_by and o.code <> ${alias}.code
      and (o.revoked_at is null or exists (select 1 from invite_redemptions x
        where x.code = o.code and x.redeemed_at is not null))) < ${INVITE_ALLOWANCE})`)

/** Delete the holds on `code` once it is revoked: they can never be claimed (`cancelHolds`). */
const cancelHolds = (db: TelaDb, code: string) =>
  db.run(sql`
    delete from invite_redemptions where code = ${code} and redeemed_at is null
      and exists (select 1 from invite_codes c where c.code = ${code} and c.revoked_at is not null)
  `)

export type CodeRaw = {
  code: string
  created_by: string | null
  by_handle: string | null
  by_name: string | null
  max_uses: number
  created_at: number
  revoked_at: number | null
  used: number
  holds: number
  joined: string
  room: number
}

/**
 * Codes aliased `c`, with their maker's card: places taken, live holds, and up to ten who joined.
 * A batch item, so a record can read them in the same snapshot as the rest of it.
 */
export const codeQuery = (db: TelaDb, where: SQL, now: number, order: SQL, limit = -1) =>
  db.all<CodeRaw>(sql`
    select c.code, c.created_by, cp.handle as by_handle, cp.display_name as by_name, c.max_uses,
      c.created_at, c.revoked_at,
      (select count(*) from invite_redemptions r
        where r.code = c.code and r.redeemed_at is not null) as used,
      (select count(*) from invite_redemptions r
        where r.code = c.code and r.redeemed_at is null and r.expires_at > ${now}) as holds,
      (select json_group_array(json_object('id', j.user_id, 'handle', j.handle,
          'name', j.display_name, 'at', j.redeemed_at))
        from (select jp.user_id, jp.handle, jp.display_name, r.redeemed_at
          from invite_redemptions r join profiles jp on jp.user_id = r.user_id
          where r.code = c.code and r.redeemed_at is not null
          order by r.redeemed_at desc, r.id desc limit 10) j) as joined,
      ${room('c')} as room
    from invite_codes c left join profiles cp on cp.user_id = c.created_by
    where ${where} order by ${order} limit ${limit}
  `)

function joinedOf(json: string): AdminPerson[] {
  try {
    const list = JSON.parse(json) as (AdminPerson & { at: number })[]
    return list
      .sort((a, b) => b.at - a.at)
      .map(({ id, handle, name }) => ({ id, handle, name: name ?? null }))
  } catch {
    return []
  }
}

/**
 * What applies to a code now: the operator's may grow while under the cap, and be revoked, used or
 * not; a member's only while nobody has joined with it, since a used code counts for good; a
 * revoked code may come back while its maker has room for it.
 */
function codeActions(r: CodeRaw): AdminActionName[] {
  if (r.revoked_at !== null) return r.room ? ['code.restore'] : []
  if (r.created_by === null) {
    return r.max_uses < MAX_USES ? ['code.addUses', 'code.revoke'] : ['code.revoke']
  }
  return r.used === 0 ? ['code.revoke'] : []
}

export function toCode(r: CodeRaw): AdminCodeRow {
  return {
    id: `${CODE_ID}${r.code}`,
    actions: codeActions(r),
    type: 'code',
    code: r.code,
    createdBy:
      r.created_by && r.by_handle
        ? { id: r.created_by, handle: r.by_handle, name: r.by_name }
        : null,
    maxUses: r.max_uses,
    used: r.used,
    holds: r.holds,
    createdAt: r.created_at,
    revokedAt: r.revoked_at,
    joined: joinedOf(r.joined),
  }
}

type HoldRaw = {
  id: number
  email: string
  code: string | null
  created_by: string | null
  by_handle: string | null
  by_name: string | null
  expires_at: number
  created_at: number
}

const holdQuery = (db: TelaDb, where: SQL, limit = -1) =>
  db.all<HoldRaw>(sql`
    select r.id, r.email, r.code, c.created_by, cp.handle as by_handle, cp.display_name as by_name,
      r.expires_at, r.created_at
    from invite_redemptions r
    left join invite_codes c on c.code = r.code
    left join profiles cp on cp.user_id = c.created_by
    where ${where} order by r.created_at desc, r.id desc limit ${limit}
  `)

function toHold(r: HoldRaw): AdminHoldRow {
  return {
    id: `${HOLD_ID}${r.id}`,
    actions: ['hold.cancel'],
    type: 'hold',
    redemptionId: r.id,
    email: r.email,
    code: r.code,
    codeOwner:
      r.created_by && r.by_handle
        ? { id: r.created_by, handle: r.by_handle, name: r.by_name }
        : null,
    expiresAt: r.expires_at,
    createdAt: r.created_at,
  }
}

/** A hold still waiting, aliased `r`: not yet redeemed, and not yet lapsed. */
const live = (now: number) => sql`r.redeemed_at is null and r.expires_at > ${now}`

/**
 * The search over codes (their text, typed with or without the dashes a member's is shown with,
 * and their maker's handle) and over holds (the address too, which only the console shows).
 */
function matchers(q: string): { code: SQL; hold: SQL } {
  const pattern = likePattern(q)
  if (pattern === null) return { code: sql`1`, hold: sql`1` }
  const bare = likePattern(q.replace(/[\s\u2010-\u2015\u2212-]/g, '')) ?? pattern
  const code = sql`(c.code like ${bare} escape '\\' or cp.handle like ${pattern} escape '\\')`
  return {
    code,
    hold: sql`(r.email like ${pattern} escape '\\' or coalesce(c.code, '') like ${bare} escape '\\'
      or coalesce(cp.handle, '') like ${pattern} escape '\\')`,
  }
}

/** `GET /invites?f=&q=` and `GET /invites/:id`. */
export function inviteRoutes(deps: ApiDeps) {
  const { db } = deps
  const routes = new Hono<AdminEnv>()

  routes.get('/invites', async (c) => {
    const f = c.req.query('f') ?? 'codes'
    if (!isAdminFilter('invites', f)) return c.json({ error: 'invalid' }, 400)
    const now = deps.clock.now()
    const match = matchers(c.req.query('q') ?? '')
    const codesFrom = sql`from invite_codes c left join profiles cp on cp.user_id = c.created_by`
    const counted = db.all<{ codes: number; waiting: number; revoked: number }>(sql`
      select
        (select count(*) ${codesFrom} where c.revoked_at is null and ${match.code}) as codes,
        (select count(*) from invite_redemptions r
          left join invite_codes c on c.code = r.code
          left join profiles cp on cp.user_id = c.created_by
          where ${live(now)} and ${match.hold}) as waiting,
        (select count(*) ${codesFrom} where c.revoked_at is not null and ${match.code}) as revoked
    `)
    const limit = ADMIN_LIST_LIMIT + 1
    let counts: { codes: number; waiting: number; revoked: number } | undefined
    let rows: (AdminCodeRow | AdminHoldRow)[]
    if (f === 'waiting') {
      const [n, holds] = await db.batch([
        counted,
        holdQuery(db, sql`${live(now)} and ${match.hold}`, limit),
      ])
      counts = n[0]
      rows = holds.map(toHold)
    } else {
      // The operator's codes first: they are the ones an operator manages.
      const where = f === 'codes' ? sql`c.revoked_at is null` : sql`c.revoked_at is not null`
      const order =
        f === 'codes'
          ? sql`c.created_by is not null, c.created_at desc, c.code`
          : sql`c.revoked_at desc, c.code`
      const [n, codes] = await db.batch([
        counted,
        codeQuery(db, sql`${where} and ${match.code}`, now, order, limit),
      ])
      counts = n[0]
      rows = codes.map(toCode)
    }
    const answer: AdminList<AdminCodeRow | AdminHoldRow, 'invites'> = {
      counts: {
        codes: counts?.codes ?? 0,
        waiting: counts?.waiting ?? 0,
        revoked: counts?.revoked ?? 0,
      },
      rows: rows.slice(0, ADMIN_LIST_LIMIT),
      truncated: rows.length > ADMIN_LIST_LIMIT,
    }
    return c.json(answer)
  })

  routes.get('/invites/:id', async (c) => {
    const id = c.req.param('id')
    const now = deps.clock.now()
    const code = codeOf(id)
    if (code !== null) {
      const [row] = await codeQuery(db, sql`c.code = ${code}`, now, sql`c.code`)
      if (!row) return c.json({ error: 'not_found' }, 404)
      const answer: AdminInviteDetail = {
        invite: toCode(row),
        history: await historyOf(db, 'code', code),
      }
      return c.json(answer)
    }
    const hold = holdOf(id)
    if (hold !== null) {
      // A hold until it is redeemed, lapsed or not, until the daily job deletes it.
      const [row] = await holdQuery(db, sql`r.id = ${hold} and r.redeemed_at is null`)
      if (!row) return c.json({ error: 'not_found' }, 404)
      const answer: AdminInviteDetail = {
        invite: toHold(row),
        history: await historyOf(db, 'hold', String(hold)),
      }
      return c.json(answer)
    }
    return c.json({ error: 'not_found' }, 404)
  })

  return routes
}

/**
 * A code of the operator's own text, with `uses` places (one when not given), as
 * `bun run admin code` makes it: normalized like any code typed in, and never in a member code's
 * shape, which is how a code says whose it is. `taken` for a code that exists, whoever made it.
 */
const createCode: ActHandler = async (ctx, _id, args) => {
  const code = normalizeInviteCode(args.code)
  if (!code || !isOperatorCode(code)) return 'invalid'
  const uses = args.uses ?? 1
  if (!Number.isInteger(uses) || uses < 1 || uses > MAX_USES) return 'invalid'
  const { db } = ctx.deps
  const results = await runBatch(db, [
    audit(
      db,
      {
        group: ctx.group,
        actor: ctx.actor,
        action: 'code.create',
        targetKind: 'code',
        targetKey: code,
        at: ctx.now,
      },
      { to: { maxUses: uses } },
      sql`where not exists (select 1 from invite_codes where code = ${code})`,
    ),
    db.all(sql`
      insert into invite_codes (code, created_by, max_uses, created_at)
      values (${code}, null, ${uses}, ${ctx.now})
      on conflict (code) do nothing
      returning code
    `),
  ])
  return returned(results[1]).length > 0 ? 'done' : 'taken'
}

/**
 * More places on an operator's code, up to the 100,000 the schema allows. A member's code admits
 * one person by design, and a revoked one admits nobody, so neither grows. No undo: the places may
 * be taken before anyone could take them back.
 */
const addUses: ActHandler = async (ctx, id, args) => {
  const code = codeOf(id)
  if (code === null) return 'not_found'
  const n = args.uses
  if (n === undefined || !Number.isInteger(n) || n < 1 || n > MAX_USES) return 'invalid'
  const { db } = ctx.deps
  const fits = sql`max_uses + ${n} <= ${MAX_USES}`
  const target = sql`code = ${code} and created_by is null and revoked_at is null and ${fits}`
  const results = await runBatch(db, [
    audit(
      db,
      {
        group: ctx.group,
        actor: ctx.actor,
        action: 'code.addUses',
        targetKind: 'code',
        targetKey: code,
        at: ctx.now,
      },
      {
        from: sql`json_object('maxUses', max_uses)`,
        to: sql`json_object('maxUses', max_uses + ${n})`,
      },
      sql`from invite_codes where ${target}`,
    ),
    db.all(sql`update invite_codes set max_uses = max_uses + ${n} where ${target} returning code`),
    db.all<{ open: number; fits: number }>(sql`
      select created_by is null and revoked_at is null as open, ${fits} as fits
      from invite_codes where code = ${code}
    `),
  ])
  if (returned(results[1]).length > 0) return 'done'
  const state = returned(results[2])[0] as { open: number; fits: number } | undefined
  if (!state) return 'not_found'
  return state.open ? 'limit' : 'not_applicable'
}

/**
 * Revoke a code: nobody else joins with it, and its holds are deleted, for good (an undo brings the
 * code back, not them). Those who joined keep their accounts. The operator's goes used or not; a
 * member's only while nobody has joined with it, as `revokeCode` has it, which frees one of their
 * five.
 */
const revoke: ActHandler = async (ctx, id) => {
  const code = codeOf(id)
  if (code === null) return 'not_found'
  const { db } = ctx.deps
  const target = sql`code = ${code} and revoked_at is null
    and (created_by is null or not ${used('invite_codes')})`
  const results = await runBatch(db, [
    audit(
      db,
      {
        group: ctx.group,
        actor: ctx.actor,
        action: 'code.revoke',
        targetKind: 'code',
        targetKey: code,
        at: ctx.now,
      },
      { from: sql`json_object('revokedAt', revoked_at)`, to: { revokedAt: ctx.now } },
      sql`from invite_codes where ${target}`,
    ),
    db.all(sql`update invite_codes set revoked_at = ${ctx.now} where ${target} returning code`),
    cancelHolds(db, code),
    db.all(sql`select code from invite_codes where code = ${code}`),
  ])
  if (returned(results[1]).length > 0) return 'done'
  return returned(results[3]).length > 0 ? 'not_applicable' : 'not_found'
}

/**
 * Open a revoked code again: the operator's always, a member's while they have room for it among
 * their five (`limit` otherwise). The holds its revocation deleted stay deleted.
 */
const restore: ActHandler = async (ctx, id) => {
  const code = codeOf(id)
  if (code === null) return 'not_found'
  const { db } = ctx.deps
  const target = sql`code = ${code} and revoked_at is not null and ${room('invite_codes')}`
  const results = await runBatch(db, [
    audit(
      db,
      {
        group: ctx.group,
        actor: ctx.actor,
        action: 'code.restore',
        targetKind: 'code',
        targetKey: code,
        at: ctx.now,
      },
      { from: sql`json_object('revokedAt', revoked_at)`, to: { revokedAt: null } },
      sql`from invite_codes where ${target}`,
    ),
    db.all(sql`update invite_codes set revoked_at = null where ${target} returning code`),
    db.all<{ revoked: number }>(
      sql`select revoked_at is not null as revoked from invite_codes where code = ${code}`,
    ),
  ])
  if (returned(results[1]).length > 0) return 'done'
  const state = returned(results[2])[0] as { revoked: number } | undefined
  if (!state) return 'not_found'
  return state.revoked ? 'limit' : 'not_applicable'
}

const revokedAt = (value: unknown): number | null => {
  const at = (value as { revokedAt?: unknown } | null)?.revokedAt
  return typeof at === 'number' ? at : null
}

/**
 * Take back a revocation: the code opens again while it still holds the revocation's stamp, and its
 * maker still has room for it.
 */
const unrevoke: Inverse = (db, change) => {
  const code = change.targetKey
  const at = revokedAt(change.to)
  return {
    changed: sql`not exists (select 1 from invite_codes c
      where c.code = ${code} and c.revoked_at = ${at} and ${room('c')})`,
    restore: [
      db.run(
        sql`update invite_codes set revoked_at = null where code = ${code} and revoked_at = ${at}`,
      ),
    ],
    synced: false,
  }
}

/**
 * Take back a restore: revoked again with its old stamp, while it is still open and, for a
 * member's, still unused; the holds placed meanwhile go, as any revocation's do.
 */
const rerevoke: Inverse = (db, change) => {
  const code = change.targetKey
  const at = revokedAt(change.from)
  return {
    changed: sql`not exists (select 1 from invite_codes c where c.code = ${code}
      and c.revoked_at is null and (c.created_by is null or not ${used('c')}))`,
    restore: [
      db.run(
        sql`update invite_codes set revoked_at = ${at} where code = ${code} and revoked_at is null`,
      ),
      cancelHolds(db, code),
    ],
    synced: false,
  }
}

/**
 * Cancel a hold: the address can no longer finish joining with it. Audited by the redemption's id
 * and its code, never the address (ADR 0039). No undo: an address is not the console's to write
 * back.
 */
const cancelHold: ActHandler = async (ctx, id) => {
  const hold = holdOf(id)
  if (hold === null) return 'not_found'
  const { db } = ctx.deps
  const target = sql`id = ${hold} and redeemed_at is null`
  const results = await runBatch(db, [
    audit(
      db,
      {
        group: ctx.group,
        actor: ctx.actor,
        action: 'hold.cancel',
        targetKind: 'hold',
        targetKey: String(hold),
        at: ctx.now,
      },
      { from: sql`json_object('code', code, 'expiresAt', expires_at)` },
      sql`from invite_redemptions where ${target}`,
    ),
    db.all(sql`delete from invite_redemptions where ${target} returning id`),
    db.all(sql`select id from invite_redemptions where id = ${hold}`),
  ])
  if (returned(results[1]).length > 0) return 'done'
  return returned(results[2]).length > 0 ? 'not_applicable' : 'not_found'
}

/**
 * Invite an address, as `bun run admin invite` does (`inviteMember`). The account is made through
 * better-auth, which no batch can hold, so the audit row follows it, naming the member made (or
 * found) and never the address.
 */
const inviteByAddress: ActHandler = async (ctx, _id, args) => {
  const invited = await inviteMember(ctx.deps, ctx.auth, args.email ?? '')
  if (!invited) return 'invalid'
  const { db } = ctx.deps
  await runBatch(db, [
    audit(
      db,
      {
        group: ctx.group,
        actor: ctx.actor,
        action: 'invite.address',
        targetKind: 'member',
        targetKey: invited.userId,
        at: ctx.now,
      },
      { to: { created: invited.created } },
    ),
  ])
  return 'done'
}

export const inviteActions = {
  'code.create': createCode,
  'code.addUses': addUses,
  'code.revoke': revoke,
  'code.restore': restore,
  'hold.cancel': cancelHold,
  'invite.address': inviteByAddress,
}

export const inviteInverses = {
  'code.revoke': unrevoke,
  'code.restore': rerevoke,
}

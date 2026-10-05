/**
 * The System area (ADR 0039): the health check, the work it watches, and what ran out of
 * attempts. A dead letter can be retried (its domain row made due again, `REDUE`) or dismissed;
 * a lease backing off after a failure can be tried now. Nothing here sends a message: the next
 * tick claims whatever is due.
 */

import {
  audit,
  bumpSeq,
  first,
  health,
  heartbeats,
  historyOf,
  isFenceRefusal,
  isRedueKind,
  LEASE_KINDS,
  type LeaseKind,
  latestBackup,
  redue,
  type TelaDb,
} from '@tela/data'
import type { Blobs } from '@tela/platform'
import {
  ADMIN_LIST_LIMIT,
  type AdminFilter,
  type AdminHeartbeats,
  type AdminLeaseRow,
  type AdminList,
  type AdminSystemDetail,
  type AdminSystemReport,
  type AdminSystemRow,
  isAdminFilter,
} from '@tela/shared/admin'
import { type SQL, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import type { ApiDeps } from '../../../deps'
import type { ActHandler, AdminEnv, Inverse } from '../framework'
import { returned, runBatch } from '../framework'
import { intKey, lookUp, targetOf, wanted, wantJob } from './names'
import { DEAD_UNRESOLVED, deadRows, toDeadRow } from './rows'

type Row = Record<string, unknown>

/** The live health check, as the console shows it. */
export async function liveHealth(db: TelaDb, blobs: Blobs, now: number) {
  const h = await health(db, blobs, now)
  return { ok: h.ok, at: now, checks: h.checks }
}

/** `dead:<n>`'s n, or null. */
export const deadIdOf = (id: string): number | null =>
  id.startsWith('dead:') ? intKey(id.slice('dead:'.length)) : null

/**
 * `lease:<kind>:<key>`'s kind and key, or null. A key may hold colons itself (a body's
 * `<contentKey>:<lang>`), so only the first two separate.
 */
export function leaseIdOf(id: string): { kind: LeaseKind; key: string } | null {
  const match = /^lease:([^:]+):(.+)$/.exec(id)
  if (!match) return null
  const [, kind, key] = match
  if (!kind || !key || !isLeaseKind(kind)) return null
  return { kind, key }
}

const isLeaseKind = (kind: string): kind is LeaseKind =>
  (LEASE_KINDS as readonly string[]).includes(kind)

/** A lease that failed and waits out its backoff: free, and not to be claimed before `not_before`. */
const BACKING_OFF = (now: number) => sql`until < ${now} and not_before > ${now}`

function toLeaseRow(
  row: Row,
  names: Awaited<ReturnType<typeof lookUp>>,
  now: number,
): AdminLeaseRow {
  const kind = String(row.kind)
  const key = String(row.key)
  const until = Number(row.until ?? 0)
  const notBefore = Number(row.not_before ?? 0)
  return {
    id: `lease:${kind}:${key}`,
    actions: until < now && notBefore > now ? ['lease.retryNow'] : [],
    type: 'lease',
    kind,
    key,
    attempts: Number(row.attempts ?? 0),
    notBefore,
    lastError:
      row.last_error === null || row.last_error === undefined ? null : String(row.last_error),
    host: row.host === null || row.host === undefined ? null : String(row.host),
    target: targetOf(names, kind, key),
  }
}

/** A search over a job's kind, key and error. */
function matching(q: string, columns: SQL): SQL {
  return q ? sql`and instr(lower(${columns}), ${q.toLowerCase()}) > 0` : sql``
}

async function systemList(
  db: TelaDb,
  filter: AdminFilter<'system'>,
  q: string,
  now: number,
): Promise<AdminList<AdminSystemRow, 'system'>> {
  const limit = ADMIN_LIST_LIMIT + 1
  const deadText = sql`d.kind || ' ' || d.key || ' ' || coalesce(d.error, '')`
  const rows =
    filter === 'retrying'
      ? db.all(sql`
          select kind, key, attempts, until, not_before, last_error, host from leases
          where ${BACKING_OFF(now)}
            ${matching(q, sql`kind || ' ' || key || ' ' || coalesce(last_error, '')`)}
          order by not_before, kind, key
          limit ${limit}
        `)
      : filter === 'resolved'
        ? deadRows(
            db,
            sql`d.resolved_at is not null ${matching(q, deadText)}`,
            sql`d.resolved_at desc, d.id desc`,
            limit,
          )
        : deadRows(
            db,
            sql`${DEAD_UNRESOLVED} ${matching(q, deadText)}`,
            sql`d.at desc, d.id desc`,
            limit,
          )
  const [counted, found] = (await runBatch(db, [
    db.all(sql`
      select (select count(*) from dead_letters where resolved_at is null) as dead,
        (select count(*) from leases where ${BACKING_OFF(now)}) as retrying,
        (select count(*) from dead_letters where resolved_at is not null) as resolved
    `),
    rows,
  ])) as [Row[], Row[]]
  const page = found.slice(0, ADMIN_LIST_LIMIT)
  const w = wanted()
  for (const r of page) wantJob(w, String(r.kind), String(r.key))
  const names = await lookUp(db, w)
  const counts = counted[0] ?? {}
  return {
    counts: {
      dead: Number(counts.dead ?? 0),
      retrying: Number(counts.retrying ?? 0),
      resolved: Number(counts.resolved ?? 0),
    },
    rows: page.map((r) =>
      filter === 'retrying' ? toLeaseRow(r, names, now) : toDeadRow(r, names),
    ),
    truncated: found.length > ADMIN_LIST_LIMIT,
  }
}

const RUNNING_CONFIG_KEYS = [
  'backgroundBudget',
  'maxArticleTokens',
  'translator',
  'relay',
  'websub',
  'assets',
] as const

/** The tick's config, if the tick that last ran reported one whole. */
export function configOf(info: Record<string, unknown> | undefined): AdminHeartbeats['config'] {
  const config = info?.config as Record<string, unknown> | undefined
  if (!config || typeof config !== 'object') return null
  if (!RUNNING_CONFIG_KEYS.every((k) => k in config)) return null
  return {
    backgroundBudget: Number(config.backgroundBudget),
    maxArticleTokens: Number(config.maxArticleTokens),
    translator: config.translator === true,
    relay: config.relay === true,
    websub: config.websub === true,
    assets: config.assets === true,
  }
}

async function systemReport(deps: ApiDeps, now: number): Promise<AdminSystemReport> {
  const { db, blobs } = deps
  const [h, beats, backup, load] = await Promise.all([
    liveHealth(db, blobs, now),
    heartbeats(db),
    latestBackup(blobs).catch(() => null),
    db.all<{ kind: string; held: number; retrying: number }>(sql`
      select kind, sum(until >= ${now}) as held, sum(${BACKING_OFF(now)}) as retrying
      from leases group by kind
    `),
  ])
  const byKind = new Map(load.map((r) => [r.kind, r]))
  return {
    health: h,
    heartbeats: {
      tick: beats.tick?.at ?? null,
      daily: beats.daily?.at ?? null,
      digest: beats.digest?.at ?? null,
      config: configOf(beats.tick?.info),
      health: beats.health ? { at: beats.health.at, ok: beats.health.info.ok === true } : null,
    },
    backup: backup
      ? {
          date: backup.date,
          finishedAt: backup.finishedAt,
          rows: backup.rows,
          verified: backup.verified,
        }
      : null,
    kinds: LEASE_KINDS.map((kind) => ({
      kind,
      held: Number(byKind.get(kind)?.held ?? 0),
      retrying: Number(byKind.get(kind)?.retrying ?? 0),
    })),
  }
}

async function systemDetail(
  db: TelaDb,
  id: string,
  now: number,
): Promise<AdminSystemDetail | null> {
  const deadId = deadIdOf(id)
  if (deadId !== null) {
    const row = await first<Row>(
      db,
      sql`select id, kind, key, attempts, error, at, resolved_at, resolution
          from dead_letters where id = ${deadId}`,
    )
    if (!row) return null
    const w = wanted()
    wantJob(w, String(row.kind), String(row.key))
    const [names, history] = await Promise.all([
      lookUp(db, w),
      historyOf(db, 'dead', String(deadId)),
    ])
    return { row: toDeadRow(row, names), history }
  }
  const lease = leaseIdOf(id)
  if (!lease) return null
  const row = await first<Row>(
    db,
    sql`select kind, key, attempts, until, not_before, last_error, host from leases
        where kind = ${lease.kind} and key = ${lease.key}`,
  )
  if (!row) return null
  const w = wanted()
  wantJob(w, lease.kind, lease.key)
  return { row: toLeaseRow(row, await lookUp(db, w), now), history: [] }
}

/**
 * Retry a dead letter: its kind's `REDUE`, and the letter resolved as `retried`, in one batch. The
 * first statement aborts the batch, as a lost lease's fence does, unless the letter is still
 * unresolved: one retried and one dismissed at once must not leave the item due and the letter
 * dismissed. No undo: the work may already have run.
 */
const retryDead: ActHandler = async (ctx, id) => {
  const deadId = deadIdOf(id)
  if (deadId === null) return 'not_found'
  const { db } = ctx.deps
  const letter = await first<{ kind: string; key: string; resolved_at: number | null }>(
    db,
    sql`select kind, key, resolved_at from dead_letters where id = ${deadId}`,
  )
  if (!letter) return 'not_found'
  if (letter.resolved_at !== null || !isRedueKind(letter.kind)) return 'not_applicable'
  const again = redue(db, letter.kind, letter.key, ctx.now)
  const unresolved = sql`from dead_letters where id = ${deadId} and resolved_at is null`
  try {
    const results = await runBatch(db, [
      db.run(
        sql`insert into lease_fence (x) select null where not exists (select 1 ${unresolved})`,
      ),
      ...(again.synced ? [bumpSeq(db)] : []),
      audit(
        db,
        {
          group: ctx.group,
          actor: ctx.actor,
          action: 'dead.retry',
          targetKind: 'dead',
          targetKey: String(deadId),
          at: ctx.now,
        },
        {
          from: sql`json_object('resolution', resolution)`,
          to: { resolution: 'retried' },
          extra: { kind: letter.kind, key: letter.key },
        },
        unresolved,
      ),
      ...again.statements,
      db.all(sql`
        update dead_letters set resolved_at = ${ctx.now}, resolution = 'retried',
          resolved_by = ${ctx.actor}
        where id = ${deadId} and resolved_at is null
        returning id
      `),
    ])
    return returned(results.at(-1)).length > 0 ? 'done' : 'not_applicable'
  } catch (err) {
    if (isFenceRefusal(err)) return 'not_applicable'
    throw err
  }
}

/** Dismiss a dead letter: nothing is retried, and it leaves the queue. */
const dismissDead: ActHandler = async (ctx, id) => {
  const deadId = deadIdOf(id)
  if (deadId === null) return 'not_found'
  const { db } = ctx.deps
  const results = await runBatch(db, [
    audit(
      db,
      {
        group: ctx.group,
        actor: ctx.actor,
        action: 'dead.dismiss',
        targetKind: 'dead',
        targetKey: String(deadId),
        at: ctx.now,
      },
      {
        from: sql`json_object('resolution', resolution)`,
        // The instant is what an undo recognises the dismissal by.
        to: { resolution: 'dismissed', resolvedAt: ctx.now },
      },
      sql`from dead_letters where id = ${deadId} and resolved_at is null`,
    ),
    db.all(sql`
      update dead_letters set resolved_at = ${ctx.now}, resolution = 'dismissed',
        resolved_by = ${ctx.actor}
      where id = ${deadId} and resolved_at is null
      returning id
    `),
    db.all(sql`select id from dead_letters where id = ${deadId}`),
  ])
  if (returned(results[1]).length > 0) return 'done'
  return returned(results[2]).length > 0 ? 'not_applicable' : 'not_found'
}

/** Take a dismissal back, while the letter is still the one that dismissal left. */
const undismissDead: Inverse = (db, change) => {
  const deadId = Number(change.targetKey)
  const at = Number((change.to as { resolvedAt?: number } | null)?.resolvedAt ?? -1)
  const still = sql`id = ${deadId} and resolution = 'dismissed' and resolved_at = ${at}`
  return {
    changed: sql`not exists (select 1 from dead_letters where ${still})`,
    restore: [
      db.run(sql`
        update dead_letters set resolved_at = null, resolution = null, resolved_by = null
        where ${still}
      `),
    ],
    synced: false,
  }
}

/**
 * Let a lease that is backing off be claimed by the next tick. Only a free lease: one someone
 * holds is work under way. Its attempts stand, so an item that fails again still dies on time.
 */
const retryLeaseNow: ActHandler = async (ctx, id) => {
  const lease = leaseIdOf(id)
  if (!lease) return 'not_found'
  const { db } = ctx.deps
  const where = sql`kind = ${lease.kind} and key = ${lease.key} and ${BACKING_OFF(ctx.now)}`
  const results = await runBatch(db, [
    audit(
      db,
      {
        group: ctx.group,
        actor: ctx.actor,
        action: 'lease.retryNow',
        targetKind: 'lease',
        targetKey: `${lease.kind}:${lease.key}`,
        at: ctx.now,
      },
      { from: sql`json_object('notBefore', not_before)`, to: { notBefore: 0 } },
      sql`from leases where ${where}`,
    ),
    db.all(sql`update leases set not_before = 0 where ${where} returning key`),
    db.all(sql`select key from leases where kind = ${lease.kind} and key = ${lease.key}`),
  ])
  if (returned(results[1]).length > 0) return 'done'
  return returned(results[2]).length > 0 ? 'not_applicable' : 'not_found'
}

export function systemRoutes(deps: ApiDeps) {
  const routes = new Hono<AdminEnv>()
  routes.get('/system', async (c) => {
    const f = c.req.query('f') ?? 'dead'
    if (!isAdminFilter('system', f)) return c.json({ error: 'invalid' }, 400)
    const q = (c.req.query('q') ?? '').trim().slice(0, 100)
    return c.json(await systemList(deps.db, f, q, deps.clock.now()))
  })
  routes.get('/system/report', async (c) => c.json(await systemReport(deps, deps.clock.now())))
  routes.get('/system/:id', async (c) => {
    const detail = await systemDetail(deps.db, c.req.param('id'), deps.clock.now())
    return detail ? c.json(detail) : c.json({ error: 'not_found' }, 404)
  })
  return routes
}

export const systemActions = {
  'dead.retry': retryDead,
  'dead.dismiss': dismissDead,
  'lease.retryNow': retryLeaseNow,
} as const

export const systemInverses = { 'dead.dismiss': undismissDead } as const

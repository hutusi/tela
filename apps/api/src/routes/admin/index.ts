/**
 * The admin console's API, `/api/v1/admin/*` (ADR 0039). Under `/api/v1`, so the member
 * middleware has already checked the session, the client and the member it names, and tela-web
 * refuses a write from another origin. On top of that: a session read past its signed five-minute
 * copy, so a member signed out or ungranted is refused at once, and `profiles.is_admin`. Never
 * under `/api/admin/*`, which takes the operator's bearer token and is let through from any
 * origin. A refusal is a 403 the console shows as a page that does not exist.
 */
import {
  audit,
  bumpSeq,
  first,
  groupRows,
  isFenceRefusal,
  laterActionOn,
  newGroupId,
  undoGuard,
} from '@tela/data'
import {
  ACTION_WRITES,
  ADMIN_BULK_MAX,
  ADMIN_REASON_MAX,
  type AdminActArgs,
  type AdminActError,
  type AdminActionName,
  type AdminActRequest,
  type AdminActResponse,
  actionsWriting,
  isAdminAction,
  UNDOABLE_ACTIONS,
} from '@tela/shared/admin'
import { sql } from 'drizzle-orm'
import type { BatchItem } from 'drizzle-orm/batch'
import { Hono } from 'hono'
import type { Auth } from '../../auth'
import type { ApiDeps } from '../../deps'
import type { ActHandler, AdminEnv, AdminModule, Inverse } from './framework'
import { runBatch } from './framework'
import { libraryModule } from './library'
import { membersModule } from './members'
import { runningModule } from './running'

/** At most this many targets in one request: one bulk action is one group, and one undo. */
export const MAX_TARGETS = ADMIN_BULK_MAX

const NO_STORE = { 'cache-control': 'no-store' }

/** The request, or null when it is not one: a known action, string ids, args of the right types. */
export function parseAct(body: unknown): AdminActRequest | null {
  if (typeof body !== 'object' || body === null) return null
  const { action, ids, args } = body as { action?: unknown; ids?: unknown; args?: unknown }
  if (!isAdminAction(action)) return null
  if (!Array.isArray(ids) || ids.length > MAX_TARGETS) return null
  if (!ids.every((id): id is string => typeof id === 'string' && id.length > 0 && id.length <= 200))
    return null
  if (new Set(ids).size !== ids.length) return null
  const a = (typeof args === 'object' && args !== null ? args : {}) as Record<string, unknown>
  const parsed: AdminActArgs = {}
  if (a.topics !== undefined) {
    if (!Array.isArray(a.topics) || !a.topics.every((t) => typeof t === 'string')) return null
    parsed.topics = a.topics as string[]
  }
  if (a.reason !== undefined) {
    if (typeof a.reason !== 'string' || a.reason.length > ADMIN_REASON_MAX) return null
    parsed.reason = a.reason
  }
  if (a.uses !== undefined) {
    if (typeof a.uses !== 'number' || !Number.isInteger(a.uses)) return null
    parsed.uses = a.uses
  }
  if (a.code !== undefined) {
    if (typeof a.code !== 'string' || a.code.length > 64) return null
    parsed.code = a.code
  }
  if (a.email !== undefined) {
    if (typeof a.email !== 'string' || a.email.length > 320) return null
    parsed.email = a.email
  }
  return { action, ids, args: parsed }
}

/** Actions that create rather than act on something, and so name no target. */
const WITHOUT_TARGET: ReadonlySet<AdminActionName> = new Set(['code.create', 'invite.address'])

const undoable = (action: string): action is (typeof UNDOABLE_ACTIONS)[number] =>
  (UNDOABLE_ACTIONS as readonly string[]).includes(action)

export function adminRoutes(deps: ApiDeps, auth: Auth) {
  const { db } = deps
  const routes = new Hono<AdminEnv>()
  const modules: AdminModule[] = [
    libraryModule(deps),
    membersModule(deps, auth),
    runningModule(deps),
  ]
  const actions: Partial<Record<AdminActionName, ActHandler>> = Object.assign(
    {},
    ...modules.map((m) => m.actions),
  )
  const inverses: Partial<Record<AdminActionName, Inverse>> = Object.assign(
    {},
    ...modules.map((m) => m.inverses),
  )

  routes.use('*', async (c, next) => {
    const found = await auth.api.getSession({
      headers: c.req.raw.headers,
      query: { disableCookieCache: true },
    })
    if (!found || found.user.id !== c.get('member').id) {
      return c.json({ error: 'unauthorized' }, 401)
    }
    const row = await first<{ is_admin: number }>(
      db,
      sql`select is_admin from profiles where user_id = ${found.user.id}`,
    )
    if (row?.is_admin !== 1) return c.json({ error: 'forbidden' }, 403, NO_STORE)
    await next()
    c.res.headers.set('cache-control', 'no-store')
  })

  routes.post('/act', async (c) => {
    const request = parseAct(await c.req.json().catch(() => null))
    if (!request) return c.json({ error: 'invalid' }, 400)
    const handler = actions[request.action]
    if (!handler) return c.json({ error: 'unknown_action' }, 404)
    const bare = WITHOUT_TARGET.has(request.action)
    if (bare !== (request.ids.length === 0)) return c.json({ error: 'invalid' }, 400)
    const group = newGroupId()
    const ctx = { deps, auth, actor: c.get('member').id, group, now: deps.clock.now() }
    const done: string[] = []
    const failed: { id: string; error: AdminActError }[] = []
    for (const id of bare ? [''] : request.ids) {
      const outcome = await handler(ctx, id, request.args ?? {})
      if (outcome === 'done') done.push(id)
      else failed.push({ id, error: outcome })
    }
    const answer: AdminActResponse = {
      done,
      failed,
      undo: done.length > 0 && undoable(request.action) ? { group } : null,
    }
    return c.json(answer)
  })

  routes.post('/undo', async (c) => {
    const body = (await c.req.json().catch(() => null)) as { group?: unknown } | null
    if (typeof body?.group !== 'string' || body.group.length > 64) {
      return c.json({ error: 'invalid' }, 400)
    }
    const group = body.group
    const rows = (await groupRows(db, group)).filter((r) => undoable(r.action))
    if (rows.length === 0) return c.json({ error: 'not_found' }, 404)
    const now = deps.clock.now()
    const own = newGroupId()
    const guards: BatchItem<'sqlite'>[] = []
    const restores: BatchItem<'sqlite'>[] = []
    const audits: BatchItem<'sqlite'>[] = []
    let synced = false
    for (const row of rows) {
      const inverse = inverses[row.action as AdminActionName]
      if (!inverse) return c.json({ error: 'not_found' }, 404)
      const detail = JSON.parse(row.detail) as { from?: unknown; to?: unknown }
      const change = {
        targetKey: row.target_key,
        from: detail.from ?? null,
        to: detail.to ?? null,
        auditId: row.id,
      }
      const step = inverse(db, change, now)
      synced ||= step.synced
      // A later operator action on the same target is a change since, whatever it left: a target
      // that left the action's value and came back to it would otherwise take stale values back.
      // One that was itself undone is not, so groups can still be undone newest first.
      const writes = ACTION_WRITES[row.action as AdminActionName]
      const later = laterActionOn(
        row.target_kind,
        row.target_key,
        row.id,
        writes === null ? [] : actionsWriting(writes),
        group,
      )
      guards.push(undoGuard(db, group, sql`(${step.changed}) or ${later}`))
      restores.push(...step.restore)
      audits.push(
        audit(
          db,
          {
            group: own,
            actor: c.get('member').id,
            action: 'undo',
            targetKind: row.target_kind,
            targetKey: row.target_key,
            at: now,
          },
          {
            from: sql`${JSON.stringify(change.to)}`,
            to: change.from,
            extra: { group, undid: row.action },
          },
        ),
      )
    }
    try {
      await runBatch(db, [...guards, ...(synced ? [bumpSeq(db)] : []), ...restores, ...audits])
    } catch (err) {
      if (isFenceRefusal(err)) return c.json({ error: 'changed_since' }, 409)
      throw err
    }
    return c.json({ restored: rows.length })
  })

  for (const module of modules) routes.route('/', module.routes)
  return routes
}

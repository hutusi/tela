/**
 * Apps (ADRs 0039, 0064, 0067): the third-party clients the operator registers, approves and cuts
 * off, and those members register in Settings → Developer. A draft connects only for its owner's
 * account, so a developer tests on production with their own; an approved app for any member; a
 * suspended one for no one, every token refused at once while its connections are kept for a
 * restore. A review is optional: the queue holds the apps whose developers asked for one, and a
 * review lifts the limits an app nobody reviewed is held to.
 *
 * Each write is one batch with its audit row. An audit row never holds an email address (ADR
 * 0039), so the developer's contact address is left out of what an edit records: undoing an edit
 * puts back everything else, and the address stays as the edit left it.
 */
import {
  audit,
  developerOk,
  endAppConnections,
  historyOf,
  newClientId,
  type TelaDb,
} from '@tela/data'
import type { AppScope, AppStatus } from '@tela/shared'
import {
  ADMIN_FILTERS,
  ADMIN_LIST_LIMIT,
  type AdminActionName,
  type AdminAppDetail,
  type AdminAppRow,
  type AdminAppSettings,
  type AdminList,
  type AdminPerson,
  isAdminFilter,
  parseAppSettings,
} from '@tela/shared/admin'
import { type SQL, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import type { ApiDeps } from '../../../deps'
import { likePattern } from '../../members'
import {
  type ActHandler,
  type AdminEnv,
  type Inverse,
  returned,
  runBatch,
  searchBody,
} from '../framework'

/** The app a row id names (its integer id, as text), or null. */
export function appOf(id: string): number | null {
  const n = Number(id)
  return Number.isSafeInteger(n) && n > 0 && String(n) === id ? n : null
}

type AppRaw = {
  id: number
  client_id: string
  name: string
  developer: string
  contact_email: string
  homepage_url: string | null
  privacy_url: string | null
  redirect_uris: string
  max_scope: AppScope
  allow_email: number
  status: AppStatus
  owner_user_id: string | null
  owner_handle: string | null
  owner_name: string | null
  per_member_per_min: number | null
  per_app_per_min: number | null
  max_connections: number | null
  created_at: number
  updated_at: number
  approved_at: number | null
  suspended_at: number | null
  connections: number
  last_used_at: number | null
  developer_id: string | null
  developer_handle: string | null
  developer_name: string | null
  terms_at: number | null
  reviewed_at: number | null
  reviewed_by: string | null
  reviewer_handle: string | null
  reviewer_name: string | null
  review_requested_at: number | null
  review_note: string | null
  review_wants_email: number
}

/**
 * Apps aliased `a`, with the cards of their owner, the member who registered them and whoever
 * reviewed them, who is connected now, and when they last acted.
 */
const appSelect = sql`
  select a.id, a.client_id, a.name, a.developer, a.contact_email, a.homepage_url, a.privacy_url,
    a.redirect_uris, a.max_scope, a.allow_email, a.status, a.owner_user_id,
    op.handle as owner_handle, op.display_name as owner_name, a.per_member_per_min,
    a.per_app_per_min, a.max_connections, a.created_at, a.updated_at, a.approved_at,
    a.suspended_at,
    (select count(*) from app_grants g where g.app_id = a.id and g.ended_at is null) as connections,
    (select max(g.last_used_at) from app_grants g where g.app_id = a.id) as last_used_at,
    a.developer_id, dp.handle as developer_handle, dp.display_name as developer_name, a.terms_at,
    a.reviewed_at, a.reviewed_by, rp.handle as reviewer_handle, rp.display_name as reviewer_name,
    a.review_requested_at, a.review_note, a.review_wants_email
  from apps a left join profiles op on op.user_id = a.owner_user_id
    left join profiles dp on dp.user_id = a.developer_id
    left join profiles rp on rp.user_id = a.reviewed_by`

/** Over `apps a`: its developer asked for a review nobody has answered (ADR 0067). */
const WAITING_REVIEW = sql`(a.review_requested_at is not null and a.reviewed_at is null)`

const personOf = (id: string | null, handle: string | null, name: string | null) =>
  id && handle ? ({ id, handle, name } satisfies AdminPerson) : null

function uris(json: string): string[] {
  try {
    const list = JSON.parse(json) as unknown
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

/**
 * What applies to an app now. A draft is approved or cut off; an approved app cut off; a cut-off
 * app restored to where it was. Any app's settings can be edited, and its connections ended while
 * it has any. An app nobody reviewed can be, unless it is cut off; one whose developer asked is
 * reviewed or its request dismissed first, as the likeliest answer (ADR 0067).
 */
function actionsFor(r: AppRaw): AdminActionName[] {
  const end = r.connections > 0 ? (['app.endConnections'] as const) : []
  const standing: AdminActionName[] =
    r.status === 'draft'
      ? ['app.approve', 'app.edit', 'app.suspend']
      : r.status === 'approved'
        ? ['app.edit', 'app.suspend']
        : ['app.restore', 'app.edit']
  if (r.reviewed_at !== null) return [...standing, ...end]
  const reviewable = r.status !== 'suspended'
  if (r.review_requested_at === null) {
    return [...standing, ...(reviewable ? (['app.review'] as const) : []), ...end]
  }
  return [
    ...(reviewable ? (['app.review'] as const) : []),
    'app.dismissReview',
    ...standing,
    ...end,
  ]
}

export function toApp(r: AppRaw): AdminAppRow {
  return {
    id: String(r.id),
    actions: actionsFor(r),
    appId: r.id,
    clientId: r.client_id,
    name: r.name,
    developer: r.developer,
    contactEmail: r.contact_email,
    homepageUrl: r.homepage_url,
    privacyUrl: r.privacy_url,
    redirectUris: uris(r.redirect_uris),
    maxScope: r.max_scope,
    allowEmail: r.allow_email === 1,
    status: r.status,
    owner:
      r.owner_user_id && r.owner_handle
        ? { id: r.owner_user_id, handle: r.owner_handle, name: r.owner_name }
        : null,
    perMemberPerMin: r.per_member_per_min,
    perAppPerMin: r.per_app_per_min,
    maxConnections: r.max_connections,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    approvedAt: r.approved_at,
    suspendedAt: r.suspended_at,
    connections: r.connections,
    lastUsedAt: r.last_used_at,
    registeredBy: personOf(r.developer_id, r.developer_handle, r.developer_name),
    termsAt: r.terms_at,
    reviewedAt: r.reviewed_at,
    reviewedBy: personOf(r.reviewed_by, r.reviewer_handle, r.reviewer_name),
    reviewRequestedAt: r.review_requested_at,
    reviewNote: r.review_note,
    reviewWantsEmail: r.review_wants_email === 1,
  }
}

/** A search over an app's name, developer, client id and contact address; everything without. */
function appMatches(q: string): SQL {
  const pattern = likePattern(q)
  if (pattern === null) return sql`1`
  return sql`(a.name like ${pattern} escape '\\' or a.developer like ${pattern} escape '\\'
    or a.client_id like ${pattern} escape '\\' or a.contact_email like ${pattern} escape '\\')`
}

/**
 * `GET /apps?f=` and `GET /apps/:id`; a search is `POST /apps {f, q}`, since an app is found by
 * its contact address too, and a request's URL reaches the Workers' logs where its body does not.
 */
export function appRoutes(deps: ApiDeps) {
  const { db } = deps
  const routes = new Hono<AdminEnv>()

  const list = async (f: string, q: string) => {
    if (!isAdminFilter('apps', f)) return null
    const matches = appMatches(q)
    // The queue is no status: an app in any status may wait for a review, the oldest first.
    const [filter, order] =
      f === 'review'
        ? [WAITING_REVIEW, sql`a.review_requested_at, a.id`]
        : [sql`a.status = ${f}`, sql`a.created_at desc, a.id desc`]
    const [counts, rows] = await db.batch([
      db.all<{ review: number; approved: number; draft: number; suspended: number }>(sql`
        select coalesce(sum(${WAITING_REVIEW}), 0) as review,
          coalesce(sum(a.status = 'approved'), 0) as approved,
          coalesce(sum(a.status = 'draft'), 0) as draft,
          coalesce(sum(a.status = 'suspended'), 0) as suspended
        from apps a where ${matches}
      `),
      db.all<AppRaw>(sql`
        ${appSelect} where ${filter} and ${matches}
        order by ${order} limit ${ADMIN_LIST_LIMIT + 1}
      `),
    ])
    const answer: AdminList<AdminAppRow, 'apps'> = {
      counts: {
        review: counts[0]?.review ?? 0,
        approved: counts[0]?.approved ?? 0,
        draft: counts[0]?.draft ?? 0,
        suspended: counts[0]?.suspended ?? 0,
      },
      rows: rows.slice(0, ADMIN_LIST_LIMIT).map(toApp),
      truncated: rows.length > ADMIN_LIST_LIMIT,
    }
    return answer
  }

  routes.get('/apps', async (c) => {
    const answer = await list(c.req.query('f') ?? ADMIN_FILTERS.apps[0], '')
    return answer ? c.json(answer) : c.json({ error: 'invalid' }, 400)
  })
  routes.post('/apps', async (c) => {
    const body = await searchBody(c.req.raw)
    const answer = body && (await list(body.f ?? ADMIN_FILTERS.apps[0], body.q))
    return answer ? c.json(answer) : c.json({ error: 'invalid' }, 400)
  })

  routes.get('/apps/:id', async (c) => {
    const id = appOf(c.req.param('id'))
    if (id === null) return c.json({ error: 'not_found' }, 404)
    const [row] = await db.all<AppRaw>(sql`${appSelect} where a.id = ${id}`)
    if (!row) return c.json({ error: 'not_found' }, 404)
    const answer: AdminAppDetail = {
      app: toApp(row),
      history: await historyOf(db, 'app', String(id)),
    }
    return c.json(answer)
  })

  return routes
}

// ---------------------------------------------------------------------------------------------
// Settings: register and edit

/**
 * What an edit records and an undo puts back: every setting but the contact address, with the
 * owner by account id. The redirects are kept as `JSON.stringify` writes them, so the text the
 * column holds is what an undo compares.
 */
type Recorded = {
  name: string
  developer: string
  homepageUrl: string | null
  privacyUrl: string | null
  redirectUris: string[]
  maxScope: AppScope
  allowEmail: boolean
  ownerUserId: string | null
  perMemberPerMin: number | null
  perAppPerMin: number | null
  maxConnections: number | null
}

const recordedOf = (s: AdminAppSettings, ownerUserId: string | null): Recorded => ({
  name: s.name,
  developer: s.developer,
  homepageUrl: s.homepageUrl,
  privacyUrl: s.privacyUrl,
  redirectUris: s.redirectUris,
  maxScope: s.maxScope,
  allowEmail: s.allowEmail,
  ownerUserId,
  perMemberPerMin: s.perMemberPerMin,
  perAppPerMin: s.perAppPerMin,
  maxConnections: s.maxConnections,
})

/** What an audit row says an app's settings were, or null for a row this build cannot read. */
function recordedFrom(value: unknown): Recorded | null {
  if (typeof value !== 'object' || value === null) return null
  const v = value as Record<string, unknown>
  const textOrNull = (x: unknown) => x === null || typeof x === 'string'
  const countOrNull = (x: unknown) => x === null || (typeof x === 'number' && Number.isInteger(x))
  if (typeof v.name !== 'string' || typeof v.developer !== 'string') return null
  if (!textOrNull(v.homepageUrl) || !textOrNull(v.privacyUrl) || !textOrNull(v.ownerUserId)) {
    return null
  }
  if (!Array.isArray(v.redirectUris) || !v.redirectUris.every((u) => typeof u === 'string')) {
    return null
  }
  if (v.maxScope !== 'read' && v.maxScope !== 'write') return null
  if (typeof v.allowEmail !== 'boolean') return null
  if (!countOrNull(v.perMemberPerMin) || !countOrNull(v.perAppPerMin)) return null
  if (!countOrNull(v.maxConnections)) return null
  return v as Recorded
}

/** Over `apps`: the settings as an audit row records them. */
const RECORDED = sql`json_object('name', name, 'developer', developer,
  'homepageUrl', homepage_url, 'privacyUrl', privacy_url, 'redirectUris', json(redirect_uris),
  'maxScope', max_scope, 'allowEmail', json(case when allow_email then 'true' else 'false' end),
  'ownerUserId', owner_user_id, 'perMemberPerMin', per_member_per_min,
  'perAppPerMin', per_app_per_min, 'maxConnections', max_connections)`

/** Over `apps`: whether it holds exactly these settings. */
const holdsSettings = (r: Recorded) => sql`(name is ${r.name} and developer is ${r.developer}
  and homepage_url is ${r.homepageUrl} and privacy_url is ${r.privacyUrl}
  and redirect_uris is ${JSON.stringify(r.redirectUris)} and max_scope is ${r.maxScope}
  and allow_email is ${r.allowEmail ? 1 : 0} and owner_user_id is ${r.ownerUserId}
  and per_member_per_min is ${r.perMemberPerMin} and per_app_per_min is ${r.perAppPerMin}
  and max_connections is ${r.maxConnections})`

/** Over `apps`: set these settings. */
const setSettings = (r: Recorded) => sql`name = ${r.name}, developer = ${r.developer},
  homepage_url = ${r.homepageUrl}, privacy_url = ${r.privacyUrl},
  redirect_uris = ${JSON.stringify(r.redirectUris)}, max_scope = ${r.maxScope},
  allow_email = ${r.allowEmail ? 1 : 0}, owner_user_id = ${r.ownerUserId},
  per_member_per_min = ${r.perMemberPerMin}, per_app_per_min = ${r.perAppPerMin},
  max_connections = ${r.maxConnections}`

/**
 * The account a handle names, for a draft's owner: undefined when no open account has it (a
 * closed account keeps its handle, and can test nothing). Null for no owner.
 */
async function ownerOf(db: TelaDb, handle: string | null): Promise<string | null | undefined> {
  if (handle === null) return null
  const [row] = await db.all<{ user_id: string }>(sql`
    select user_id from profiles where handle = ${handle} and deleted_at is null
  `)
  return row?.user_id
}

/**
 * Register an app, as a draft: it connects only for its owner until it is approved. Its
 * `client_id` is made here, and is the app's public name in every authorization request. The
 * operator's own registration is reviewed as it is made (ADR 0067): nobody else need check it.
 */
const createApp: ActHandler = async (ctx, _id, args) => {
  const parsed = parseAppSettings(args.app)
  if (!parsed.ok) return 'invalid'
  const s = parsed.value
  const { db } = ctx.deps
  const owner = await ownerOf(db, s.owner)
  if (owner === undefined) return 'invalid'
  const recorded = recordedOf(s, owner)
  const clientId = newClientId()
  const results = await runBatch(db, [
    db.all(sql`
      insert into apps (client_id, name, developer, contact_email, homepage_url, privacy_url,
        redirect_uris, max_scope, allow_email, status, owner_user_id, per_member_per_min,
        per_app_per_min, max_connections, reviewed_at, reviewed_by, created_at, updated_at)
      values (${clientId}, ${s.name}, ${s.developer}, ${s.contactEmail}, ${s.homepageUrl},
        ${s.privacyUrl}, ${JSON.stringify(s.redirectUris)}, ${s.maxScope}, ${s.allowEmail ? 1 : 0},
        'draft', ${owner}, ${s.perMemberPerMin}, ${s.perAppPerMin}, ${s.maxConnections},
        ${ctx.now}, ${ctx.actor}, ${ctx.now}, ${ctx.now})
      returning id
    `),
    audit(
      db,
      {
        group: ctx.group,
        actor: ctx.actor,
        action: 'app.create',
        targetKind: 'app',
        targetKey: sql`cast(id as text)`,
        at: ctx.now,
      },
      { to: { ...recorded, clientId } },
      sql`from apps where client_id = ${clientId}`,
    ),
  ])
  return returned(results[0]).length > 0 ? 'done' : 'invalid'
}

/**
 * Change an app's settings: its name and developer, where it may send members back to, how much
 * it may ask for, whose draft it is, and its limits. Lowering its scope or taking away the email
 * reaches its live tokens at once, since each request reads the app's ceiling. Saving what it
 * already holds changes nothing (`not_applicable`). A member's app stays its developer's to test
 * (ADR 0067): its owner is them, whatever the form names.
 */
const editApp: ActHandler = async (ctx, id, args) => {
  const appId = appOf(id)
  if (appId === null) return 'not_found'
  const parsed = parseAppSettings(args.app)
  if (!parsed.ok) return 'invalid'
  const s = parsed.value
  const { db } = ctx.deps
  // Who registered it never changes once it is made, so reading it apart from the batch is safe.
  const [held] = await db.all<{ developer_id: string | null }>(
    sql`select developer_id from apps where id = ${appId}`,
  )
  if (!held) return 'not_found'
  const owner = held.developer_id ?? (await ownerOf(db, s.owner))
  if (owner === undefined) return 'invalid'
  const recorded = recordedOf(s, owner)
  const target = sql`id = ${appId}
    and not (${holdsSettings(recorded)} and contact_email is ${s.contactEmail})`
  const results = await runBatch(db, [
    audit(
      db,
      {
        group: ctx.group,
        actor: ctx.actor,
        action: 'app.edit',
        targetKind: 'app',
        targetKey: String(appId),
        at: ctx.now,
      },
      { from: RECORDED, to: recorded },
      sql`from apps where ${target}`,
    ),
    db.all(sql`
      update apps set ${setSettings(recorded)}, contact_email = ${s.contactEmail},
        updated_at = ${ctx.now}
      where ${target} returning id
    `),
    db.all(sql`select id from apps where id = ${appId}`),
  ])
  if (returned(results[1]).length > 0) return 'done'
  return returned(results[2]).length > 0 ? 'not_applicable' : 'not_found'
}

/** Take an edit back while the app still holds what it wrote. The contact address stays. */
const unedit: Inverse = (db, change, now) => {
  const to = recordedFrom(change.to)
  const from = recordedFrom(change.from)
  const id = appOf(change.targetKey)
  if (!to || !from || id === null) return { changed: sql`1`, restore: [], synced: false }
  const holds = sql`id = ${id} and ${holdsSettings(to)}`
  return {
    changed: sql`not exists (select 1 from apps where ${holds})`,
    restore: [
      db.run(sql`update apps set ${setSettings(from)}, updated_at = ${now} where ${holds}`),
    ],
    synced: false,
  }
}

// ---------------------------------------------------------------------------------------------
// Where it stands: approve, cut off, restore

/** Over `apps`: where it stands, as an audit row records it. */
const STANDING = sql`json_object('status', status, 'approvedAt', approved_at,
  'suspendedAt', suspended_at)`

type Standing = { status: AppStatus; approvedAt: number | null; suspendedAt: number | null }

function standingFrom(value: unknown): Standing | null {
  if (typeof value !== 'object' || value === null) return null
  const v = value as Record<string, unknown>
  const at = (x: unknown) => x === null || x === undefined || typeof x === 'number'
  if (v.status !== 'draft' && v.status !== 'approved' && v.status !== 'suspended') return null
  if (!at(v.approvedAt) || !at(v.suspendedAt)) return null
  return {
    status: v.status,
    approvedAt: (v.approvedAt as number | null | undefined) ?? null,
    suspendedAt: (v.suspendedAt as number | null | undefined) ?? null,
  }
}

/**
 * Move an app from where `from` says to where `to` (a JSON expression over the row) and `set`
 * put it, in one batch with its audit row.
 */
function moveStanding(
  action: 'app.approve' | 'app.suspend' | 'app.restore',
  from: SQL,
  to: (now: number) => SQL,
  set: (now: number) => SQL,
): ActHandler {
  return async (ctx, id) => {
    const appId = appOf(id)
    if (appId === null) return 'not_found'
    const { db } = ctx.deps
    const target = sql`id = ${appId} and ${from}`
    const results = await runBatch(db, [
      audit(
        db,
        {
          group: ctx.group,
          actor: ctx.actor,
          action,
          targetKind: 'app',
          targetKey: String(appId),
          at: ctx.now,
        },
        { from: STANDING, to: to(ctx.now) },
        sql`from apps where ${target}`,
      ),
      db.all(sql`update apps set ${set(ctx.now)}, updated_at = ${ctx.now}
        where ${target} returning id`),
      db.all(sql`select id from apps where id = ${appId}`),
    ])
    if (returned(results[1]).length > 0) return 'done'
    return returned(results[2]).length > 0 ? 'not_applicable' : 'not_found'
  }
}

/** A draft any member may connect from now on. */
const approve = moveStanding(
  'app.approve',
  sql`status = 'draft'`,
  (now) => sql`json_object('status', 'approved', 'approvedAt', ${now},
    'suspendedAt', suspended_at)`,
  (now) => sql`status = 'approved', approved_at = ${now}`,
)

/**
 * Cut an app off for everyone: every token it holds is refused from the next request, by the
 * check every request makes of the app's status. Connections are kept, so a restore brings the
 * app back for those who connected it, without asking them again.
 */
const suspend = moveStanding(
  'app.suspend',
  sql`status in ('draft', 'approved')`,
  (now) =>
    sql`json_object('status', 'suspended', 'approvedAt', approved_at, 'suspendedAt', ${now})`,
  (now) => sql`status = 'suspended', suspended_at = ${now}`,
)

/** Back to where it stood before it was cut off: approved if it ever was, else a draft. */
const BACK = sql`case when approved_at is not null then 'approved' else 'draft' end`
const restore = moveStanding(
  'app.restore',
  sql`status = 'suspended'`,
  () => sql`json_object('status', ${BACK}, 'approvedAt', approved_at, 'suspendedAt', null)`,
  () => sql`status = ${BACK}, suspended_at = null`,
)

/** Put an app back where it stood while it still stands where the action left it. */
const restoreStanding: Inverse = (db, change, now) => {
  const to = standingFrom(change.to)
  const from = standingFrom(change.from)
  const id = appOf(change.targetKey)
  if (!to || !from || id === null) return { changed: sql`1`, restore: [], synced: false }
  const holds = sql`id = ${id} and status = ${to.status} and approved_at is ${to.approvedAt}
    and suspended_at is ${to.suspendedAt}`
  return {
    changed: sql`not exists (select 1 from apps where ${holds})`,
    restore: [
      db.run(sql`update apps set status = ${from.status}, approved_at = ${from.approvedAt},
        suspended_at = ${from.suspendedAt}, updated_at = ${now} where ${holds}`),
    ],
    synced: false,
  }
}

// ---------------------------------------------------------------------------------------------
// Reviews (ADR 0067)

/** Over `apps`: its review, the request it answers and the email permission, as audited. */
const REVIEW = sql`json_object('reviewedAt', reviewed_at, 'reviewedBy', reviewed_by,
  'reviewRequestedAt', review_requested_at,
  'allowEmail', json(case when allow_email then 'true' else 'false' end))`

type Review = {
  reviewedAt: number | null
  reviewedBy: string | null
  reviewRequestedAt: number | null
  allowEmail: boolean
}

function reviewFrom(value: unknown): Review | null {
  if (typeof value !== 'object' || value === null) return null
  const v = value as Record<string, unknown>
  const at = (x: unknown) => x === null || (typeof x === 'number' && Number.isInteger(x))
  if (!at(v.reviewedAt) || !at(v.reviewRequestedAt)) return null
  if (v.reviewedBy !== null && typeof v.reviewedBy !== 'string') return null
  if (typeof v.allowEmail !== 'boolean') return null
  return v as Review
}

/** Over `apps`: whether it holds exactly this review. */
const holdsReview = (r: Review) => sql`(reviewed_at is ${r.reviewedAt}
  and reviewed_by is ${r.reviewedBy} and review_requested_at is ${r.reviewRequestedAt}
  and allow_email is ${r.allowEmail ? 1 : 0})`

/**
 * Review an app nobody reviewed: it is held to its own limits from now on, no longer to those of
 * an unreviewed app, and may ask for the email address if the operator says so (`allowEmail`,
 * required: the developer may have asked, but the answer is the operator's). It answers any
 * request its developer made. A cut-off app is restored first, then reviewed.
 */
const review: ActHandler = async (ctx, id, args) => {
  const appId = appOf(id)
  if (appId === null) return 'not_found'
  if (typeof args.allowEmail !== 'boolean') return 'invalid'
  // The version the operator read: a developer who edited the app since, its name or its
  // redirects, would otherwise have the review land on what nobody looked at.
  if (typeof args.seen !== 'number') return 'invalid'
  const { db } = ctx.deps
  const to: Review = {
    reviewedAt: ctx.now,
    reviewedBy: ctx.actor,
    reviewRequestedAt: null,
    allowEmail: args.allowEmail,
  }
  const target = sql`id = ${appId} and reviewed_at is null and status <> 'suspended'
    and updated_at = ${args.seen}`
  const results = await runBatch(db, [
    audit(
      db,
      {
        group: ctx.group,
        actor: ctx.actor,
        action: 'app.review',
        targetKind: 'app',
        targetKey: String(appId),
        at: ctx.now,
      },
      { from: REVIEW, to },
      sql`from apps where ${target}`,
    ),
    db.all(sql`update apps set reviewed_at = ${ctx.now}, reviewed_by = ${ctx.actor},
        review_requested_at = null, allow_email = ${to.allowEmail ? 1 : 0}, updated_at = ${ctx.now}
      where ${target} returning id`),
    db.all(sql`select id from apps where id = ${appId}`),
  ])
  if (returned(results[1]).length > 0) return 'done'
  return returned(results[2]).length > 0 ? 'not_applicable' : 'not_found'
}

/**
 * Answer a request for a review with none: the app stays as it is, held to an unreviewed app's
 * limits, and its developer may ask again. Their note stays with the app.
 */
const dismissReview: ActHandler = async (ctx, id) => {
  const appId = appOf(id)
  if (appId === null) return 'not_found'
  const { db } = ctx.deps
  const target = sql`id = ${appId} and review_requested_at is not null and reviewed_at is null`
  const results = await runBatch(db, [
    audit(
      db,
      {
        group: ctx.group,
        actor: ctx.actor,
        action: 'app.dismissReview',
        targetKind: 'app',
        targetKey: String(appId),
        at: ctx.now,
      },
      { from: REVIEW, to: sql`json_set(${REVIEW}, '$.reviewRequestedAt', null)` },
      sql`from apps where ${target}`,
    ),
    db.all(sql`update apps set review_requested_at = null, updated_at = ${ctx.now}
      where ${target} returning id`),
    db.all(sql`select id from apps where id = ${appId}`),
  ])
  if (returned(results[1]).length > 0) return 'done'
  return returned(results[2]).length > 0 ? 'not_applicable' : 'not_found'
}

/** Take a review or a dismissal back while the app still holds what it left. */
const unreview: Inverse = (db, change, now) => {
  const to = reviewFrom(change.to)
  const from = reviewFrom(change.from)
  const id = appOf(change.targetKey)
  if (!to || !from || id === null) return { changed: sql`1`, restore: [], synced: false }
  const holds = sql`id = ${id} and ${holdsReview(to)}`
  return {
    changed: sql`not exists (select 1 from apps where ${holds})`,
    restore: [
      db.run(sql`update apps set reviewed_at = ${from.reviewedAt}, reviewed_by = ${from.reviewedBy},
          review_requested_at = ${from.reviewRequestedAt}, allow_email = ${from.allowEmail ? 1 : 0},
          updated_at = ${now}
        where ${holds}`),
    ],
    synced: false,
  }
}

// ---------------------------------------------------------------------------------------------
// End all connections

/**
 * End every member's connection to an app, and every device's tokens under them
 * (`endAppConnections`, reason `appEnded`). The app stays as it stands: an approved app can be
 * connected again, by a member who chooses to. No undo: a connection ended is not given back.
 */
const endConnections: ActHandler = async (ctx, id) => {
  const appId = appOf(id)
  if (appId === null) return 'not_found'
  const { db } = ctx.deps
  const live = sql`select id from app_grants where app_id = ${appId} and ended_at is null`
  const results = await runBatch(db, [
    audit(
      db,
      {
        group: ctx.group,
        actor: ctx.actor,
        action: 'app.endConnections',
        targetKind: 'app',
        targetKey: String(appId),
        at: ctx.now,
      },
      {
        from: sql`json_object('connections', (select count(*) from (${live})))`,
        to: { connections: 0 },
      },
      sql`from apps where id = ${appId} and exists (${live})`,
    ),
    // The grants it ends, read in the batch's own snapshot before the statements that end them.
    db.all(live),
    ...endAppConnections(db, appId, 'appEnded', ctx.now),
    db.all(sql`select id from apps where id = ${appId}`),
  ])
  if (returned(results[1]).length > 0) return 'done'
  return returned(results.at(-1)).length > 0 ? 'not_applicable' : 'not_found'
}

export const appActions = {
  'app.create': createApp,
  'app.edit': editApp,
  'app.approve': approve,
  'app.suspend': suspend,
  'app.restore': restore,
  'app.endConnections': endConnections,
  'app.review': review,
  'app.dismissReview': dismissReview,
}

export const appInverses = {
  'app.edit': unedit,
  'app.approve': restoreStanding,
  'app.suspend': restoreStanding,
  'app.restore': restoreStanding,
  'app.review': unreview,
  'app.dismissReview': unreview,
}

/**
 * Every live app's name and contact address (`bun run admin app-contacts`, ADR 0067): where the
 * operator sends API notices, a preview's break or a deprecation. The operator's token alone
 * reads it; the console never lists the addresses together, and no audit row holds one.
 */
export async function liveAppContacts(
  db: TelaDb,
): Promise<{ clientId: string; name: string; contactEmail: string }[]> {
  const rows = await db.all<{ client_id: string; name: string; contact_email: string }>(sql`
    select client_id, name, contact_email from apps a
    where a.status = 'approved' and a.contact_email <> '' and ${developerOk('a')}
    order by a.name, a.id
  `)
  return rows.map((r) => ({ clientId: r.client_id, name: r.name, contactEmail: r.contact_email }))
}

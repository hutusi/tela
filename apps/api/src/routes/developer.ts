/**
 * Settings → Developer (ADR 0067): the apps a member registers for themselves, as on GitHub.
 * Internal member routes under `/api/v1/developer/apps`, behind the web's member, client and
 * origin checks; every write, and the list, reads the member's standing first. Each answers only
 * for an app whose `developer_id` is the member: anyone else's, the operator's included, is a 404.
 *
 * - `GET /`: `{ apps: DeveloperApp[] }`, newest first.
 * - `POST /` `{...DeveloperAppSettings, acceptTerms: true}`: registers one in Testing (`draft`),
 *   its contact address the account's unless another is given; `{ app }`, 201.
 * - `PUT /:id` `{...DeveloperAppSettings}`: changes it. A new name, redirect or scope clears its
 *   review and the email permission in the same statement: what Tela reviewed is no longer it.
 * - `POST /:id/live` `{ live }`: Live (`approved`, which needs a privacy policy) or back to Testing,
 *   which ends every other member's connection. A cut-off app moves neither way.
 * - `POST /:id/review` `{ note, wantsEmail }`: asks Tela for a review.
 * - `DELETE /:id`: deletes it, with its connections, tokens and codes, unless it is cut off or an
 *   open report names it, so deleting is no way out of either.
 *
 * Refusals are `DeveloperError`s. Registering and editing count `appRegister` (ten a day); the
 * apps a member holds are counted against `apps.perMember` inside the insert, so two at once
 * cannot both take the last place; an admin is exempt from that on the web, as from every member
 * limit. Every write is one batch with its audit row (actor the member, target the app), so the
 * console's history shows what the developer did; never the contact address (ADR 0039).
 */
import {
  audit,
  consumeLimit,
  effectiveMaxConnections,
  endOthersConnections,
  newClientId,
  newGroupId,
  settingSql,
} from '@tela/data'
import {
  type AppScope,
  type AppStatus,
  type DeveloperAction,
  type DeveloperApp,
  type DeveloperAppSettings,
  type DeveloperError,
  parseDeveloperApp,
  parseReviewNote,
} from '@tela/shared'
import { type SQL, sql } from 'drizzle-orm'
import type { Context } from 'hono'
import { Hono } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import type { ApiEnv } from '../app'
import type { ApiDeps } from '../deps'
import { webActor } from '../web-actor'

type Raw = {
  id: number
  client_id: string
  name: string
  developer: string
  contact_email: string
  homepage_url: string | null
  privacy_url: string | null
  redirect_uris: string
  max_scope: AppScope
  status: AppStatus
  reviewed: number
  review_requested_at: number | null
  review_wants_email: number
  connections: number
  cap: number | null
  created_at: number
  approved_at: number | null
  suspended_at: number | null
}

/**
 * Apps aliased `a`, as Settings → Developer shows them: how many members are connected (a count,
 * never who), and for an app Tela has not reviewed, the cap its developer's unreviewed apps share.
 */
const SELECT = sql`
  select a.id, a.client_id, a.name, a.developer, a.contact_email, a.homepage_url, a.privacy_url,
    a.redirect_uris, a.max_scope, a.status, (a.reviewed_at is not null) as reviewed,
    a.review_requested_at, a.review_wants_email,
    (select count(*) from app_grants g where g.app_id = a.id and g.ended_at is null) as connections,
    case when a.reviewed_at is null then ${effectiveMaxConnections('a')} end as cap,
    a.created_at, a.approved_at, a.suspended_at
  from apps a`

function uris(json: string): string[] {
  try {
    const list = JSON.parse(json) as unknown
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

function toApp(r: Raw): DeveloperApp {
  return {
    appId: r.id,
    clientId: r.client_id,
    name: r.name,
    developer: r.developer,
    contactEmail: r.contact_email,
    homepageUrl: r.homepage_url,
    privacyUrl: r.privacy_url,
    redirectUris: uris(r.redirect_uris),
    maxScope: r.max_scope,
    status: r.status,
    reviewed: r.reviewed === 1,
    reviewRequestedAt: r.review_requested_at,
    reviewWantsEmail: r.review_wants_email === 1,
    connections: r.connections,
    cap: r.cap,
    createdAt: r.created_at,
    approvedAt: r.approved_at,
    suspendedAt: r.suspended_at,
  }
}

/** Over `apps`: what an audit row records of an app's settings, never its contact address. */
const RECORDED = sql`'name', name, 'developer', developer, 'homepageUrl', homepage_url,
  'privacyUrl', privacy_url, 'redirectUris', json(redirect_uris), 'maxScope', max_scope`

/** Over `apps`: where it stands, as the console's own audit rows record it. */
const STANDING = sql`json_object('status', status, 'approvedAt', approved_at,
  'suspendedAt', suspended_at)`

const bool = (condition: SQL) => sql`json(case when ${condition} then 'true' else 'false' end)`

/** What an audit row records of settings a member sends: everything but the contact address. */
const recordedOf = (s: DeveloperAppSettings) => ({
  name: s.name,
  developer: s.developer,
  homepageUrl: s.homepageUrl,
  privacyUrl: s.privacyUrl,
  redirectUris: s.redirectUris,
  maxScope: s.maxScope,
})

/** A JSON object's fields; anything else, `null` and malformed JSON included, has none. */
async function fields(c: Context): Promise<Record<string, unknown> | null> {
  const body: unknown = await c.req.json().catch(() => null)
  return typeof body === 'object' && body !== null && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : null
}

/** The app an `:id` names, or null for one that is not a positive whole number. */
function idOf(param: string): number | null {
  const n = Number(param)
  return Number.isSafeInteger(n) && n > 0 ? n : null
}

const refuse = (
  c: Context,
  error: DeveloperError,
  status: ContentfulStatusCode,
  extra: Record<string, string> = {},
) => c.json({ error, ...extra }, status)

export function developerRoutes(deps: ApiDeps) {
  const { db, clock } = deps
  const routes = new Hono<ApiEnv>()

  /** The member's app `id` as it stands: one row, or none when no app of theirs has that id. */
  const own = (id: number, member: string) =>
    db.all<Raw>(sql`${SELECT} where a.id = ${id} and a.developer_id = ${member}`)

  /** The audit row for a member's change to the app the source matches. */
  const audited = (
    action: DeveloperAction,
    member: string,
    now: number,
    targetKey: string | SQL,
    change: { from?: SQL; to?: unknown },
    source: SQL,
  ) =>
    audit(
      db,
      { group: newGroupId(), actor: member, action, targetKind: 'app', targetKey, at: now },
      change,
      source,
    )

  /**
   * A member's settings, checked as every registration is (`parseDeveloperApp`), the contact
   * address the account's own when none is given; or the refusal.
   */
  const settingsOf = (c: Context<ApiEnv>, body: Record<string, unknown>) => {
    const given = body.contactEmail
    const contactEmail =
      given === undefined || given === null || given === '' ? c.get('member').email : given
    return parseDeveloperApp({ ...body, contactEmail })
  }

  /** Count a registration or an edit; a refusal answer when the day's are spent. */
  const spend = async (c: Context<ApiEnv>, member: string, now: number) => {
    const limited = await consumeLimit(db, 'appRegister', member, now)
    if (limited.allowed) return null
    return c.json({ error: 'rate_limited' satisfies DeveloperError }, 429, {
      'retry-after': String(limited.retryAfterSec),
    })
  }

  routes.get('/', async (c) => {
    const rows = await db.all<Raw>(sql`
      ${SELECT} where a.developer_id = ${c.get('member').id}
      order by a.created_at desc, a.id desc
    `)
    return c.json({ apps: rows.map(toApp) }, 200, { 'cache-control': 'no-store' })
  })

  routes.post('/', async (c) => {
    const body = await fields(c)
    if (!body) return refuse(c, 'invalid', 400, { field: 'name' })
    const parsed = settingsOf(c, body)
    if (!parsed.ok) return refuse(c, 'invalid', 400, { field: parsed.field })
    if (body.acceptTerms !== true) return refuse(c, 'terms', 400)
    const s = parsed.value
    const member = c.get('member').id
    const now = clock.now()
    const spent = await spend(c, member, now)
    if (spent) return spent
    const { exempt } = await webActor(c, db)
    const perMember = settingSql('apps.perMember')
    const room = exempt
      ? sql`1`
      : sql`(${perMember} is null
          or (select count(*) from apps where developer_id = ${member}) < ${perMember})`
    const clientId = newClientId()
    const [inserted, , rows] = (await db.batch([
      db.all<{ id: number }>(sql`
        insert into apps (client_id, name, developer, contact_email, homepage_url, privacy_url,
          redirect_uris, max_scope, allow_email, status, owner_user_id, developer_id, terms_at,
          created_at, updated_at)
        select ${clientId}, ${s.name}, ${s.developer}, ${s.contactEmail}, ${s.homepageUrl},
          ${s.privacyUrl}, ${JSON.stringify(s.redirectUris)}, ${s.maxScope}, 0, 'draft',
          ${member}, ${member}, ${now}, ${now}, ${now}
        where ${room}
        returning id
      `),
      audited(
        'developer.register',
        member,
        now,
        sql`cast(id as text)`,
        { to: { ...recordedOf(s), clientId } },
        sql`from apps where client_id = ${clientId}`,
      ),
      db.all<Raw>(sql`${SELECT} where a.client_id = ${clientId}`),
    ] as never)) as unknown as [{ id: number }[], unknown, Raw[]]
    const app = rows[0]
    if (inserted.length === 0 || !app) return refuse(c, 'too_many_apps', 409)
    return c.json({ app: toApp(app) }, 201)
  })

  routes.put('/:id{[0-9]+}', async (c) => {
    const id = idOf(c.req.param('id'))
    const body = await fields(c)
    if (id === null) return refuse(c, 'not_found', 404)
    if (!body) return refuse(c, 'invalid', 400, { field: 'name' })
    const parsed = settingsOf(c, body)
    if (!parsed.ok) return refuse(c, 'invalid', 400, { field: parsed.field })
    const s = parsed.value
    const member = c.get('member').id
    const now = clock.now()
    const spent = await spend(c, member, now)
    if (spent) return spent
    const redirects = JSON.stringify(s.redirectUris)
    // Over the row as it stood: what Tela reviewed is no longer this app.
    const clears = sql`(name is not ${s.name} or redirect_uris is not ${redirects}
      or max_scope is not ${s.maxScope})`
    const holds = sql`(name is ${s.name} and developer is ${s.developer}
      and contact_email is ${s.contactEmail} and homepage_url is ${s.homepageUrl}
      and privacy_url is ${s.privacyUrl} and redirect_uris is ${redirects}
      and max_scope is ${s.maxScope})`
    const target = sql`id = ${id} and developer_id = ${member} and not ${holds}`
    const [, , rows] = (await db.batch([
      audited(
        'developer.edit',
        member,
        now,
        String(id),
        {
          from: sql`json_object(${RECORDED}, 'reviewed', ${bool(sql`reviewed_at is not null`)},
            'allowEmail', ${bool(sql`allow_email = 1`)})`,
          to: sql`json_object('name', ${s.name}, 'developer', ${s.developer},
            'homepageUrl', ${s.homepageUrl}, 'privacyUrl', ${s.privacyUrl},
            'redirectUris', json(${redirects}), 'maxScope', ${s.maxScope},
            'reviewed', ${bool(sql`not ${clears} and reviewed_at is not null`)},
            'allowEmail', ${bool(sql`not ${clears} and allow_email = 1`)})`,
        },
        sql`from apps where ${target}`,
      ),
      db.run(sql`
        update apps set name = ${s.name}, developer = ${s.developer},
          contact_email = ${s.contactEmail}, homepage_url = ${s.homepageUrl},
          privacy_url = ${s.privacyUrl}, redirect_uris = ${redirects}, max_scope = ${s.maxScope},
          reviewed_at = case when ${clears} then null else reviewed_at end,
          reviewed_by = case when ${clears} then null else reviewed_by end,
          allow_email = case when ${clears} then 0 else allow_email end,
          updated_at = ${now}
        where ${target}
      `),
      own(id, member),
    ] as never)) as unknown as [unknown, unknown, Raw[]]
    const app = rows[0]
    return app ? c.json({ app: toApp(app) }) : refuse(c, 'not_found', 404)
  })

  routes.post('/:id{[0-9]+}/live', async (c) => {
    const id = idOf(c.req.param('id'))
    const body = await fields(c)
    if (id === null) return refuse(c, 'not_found', 404)
    const live = body?.live
    if (typeof live !== 'boolean') return refuse(c, 'invalid', 400, { field: 'live' })
    const member = c.get('member').id
    const now = clock.now()
    const mine = sql`id = ${id} and developer_id = ${member}`
    const rows = live
      ? await goLive({ id, member, now, mine })
      : await backToTesting({ id, member, now, mine })
    const app = rows[0]
    if (!app) return refuse(c, 'not_found', 404)
    if (app.status === 'suspended') return refuse(c, 'cut_off', 409)
    if (live && app.status !== 'approved') return refuse(c, 'privacy_required', 400)
    return c.json({ app: toApp(app) })
  })

  /** Live, for any member to connect: only from Testing, and only with a privacy policy. */
  async function goLive({
    id,
    member,
    now,
    mine,
  }: {
    id: number
    member: string
    now: number
    mine: SQL
  }): Promise<Raw[]> {
    const moves = sql`${mine} and status = 'draft' and privacy_url is not null`
    const results = (await db.batch([
      audited(
        'developer.live',
        member,
        now,
        String(id),
        {
          from: STANDING,
          to: sql`json_object('status', 'approved', 'approvedAt', ${now},
            'suspendedAt', suspended_at)`,
        },
        sql`from apps where ${moves}`,
      ),
      db.run(sql`update apps set status = 'approved', approved_at = ${now}, updated_at = ${now}
        where ${moves}`),
      own(id, member),
    ] as never)) as unknown as unknown[]
    return results.at(-1) as Raw[]
  }

  /**
   * Back to Testing, where only its developer connects it: `approved_at` cleared too, or the
   * console's Restore would make it Live again, and every other member's connection ended.
   */
  async function backToTesting({
    id,
    member,
    now,
    mine,
  }: {
    id: number
    member: string
    now: number
    mine: SQL
  }): Promise<Raw[]> {
    const moves = sql`${mine} and status = 'approved'`
    const results = (await db.batch([
      audited(
        'developer.testing',
        member,
        now,
        String(id),
        {
          from: STANDING,
          to: sql`json_object('status', 'draft', 'approvedAt', null, 'suspendedAt', suspended_at)`,
        },
        sql`from apps where ${moves}`,
      ),
      db.run(sql`update apps set status = 'draft', approved_at = null, updated_at = ${now}
        where ${moves}`),
      // A draft acts only for its developer, so nobody else's connection to it is kept.
      ...endOthersConnections(
        db,
        id,
        'appEnded',
        now,
        sql`exists (select 1 from apps where ${mine} and status = 'draft')`,
      ),
      own(id, member),
    ] as never)) as unknown as unknown[]
    return results.at(-1) as Raw[]
  }

  routes.post('/:id{[0-9]+}/review', async (c) => {
    const id = idOf(c.req.param('id'))
    const body = await fields(c)
    if (id === null) return refuse(c, 'not_found', 404)
    const note = parseReviewNote(body?.note)
    if (note === undefined) return refuse(c, 'invalid', 400, { field: 'note' })
    const wantsEmail = body?.wantsEmail
    if (typeof wantsEmail !== 'boolean') return refuse(c, 'invalid', 400, { field: 'wantsEmail' })
    const member = c.get('member').id
    const now = clock.now()
    const moves = sql`id = ${id} and developer_id = ${member} and status <> 'suspended'`
    const [, , rows] = (await db.batch([
      audited(
        'developer.review',
        member,
        now,
        String(id),
        {
          from: sql`json_object('requestedAt', review_requested_at, 'note', review_note,
            'wantsEmail', ${bool(sql`review_wants_email = 1`)})`,
          to: { requestedAt: now, note, wantsEmail },
        },
        sql`from apps where ${moves}`,
      ),
      db.run(sql`update apps set review_requested_at = ${now}, review_note = ${note},
          review_wants_email = ${wantsEmail ? 1 : 0}, updated_at = ${now}
        where ${moves}`),
      own(id, member),
    ] as never)) as unknown as [unknown, unknown, Raw[]]
    const app = rows[0]
    if (!app) return refuse(c, 'not_found', 404)
    if (app.status === 'suspended') return refuse(c, 'cut_off', 409)
    return c.json({ app: toApp(app) })
  })

  routes.delete('/:id{[0-9]+}', async (c) => {
    const id = idOf(c.req.param('id'))
    if (id === null) return refuse(c, 'not_found', 404)
    const member = c.get('member').id
    const now = clock.now()
    const mine = sql`id = ${id} and developer_id = ${member}`
    const reported = sql`exists (select 1 from reports r where r.target_kind = 'app'
      and r.target_key = apps.client_id and r.state = 'open')`
    const goes = sql`${mine} and status <> 'suspended' and not ${reported}`
    const [, deleted, left] = (await db.batch([
      audited(
        'developer.delete',
        member,
        now,
        String(id),
        { from: sql`json_object(${RECORDED}, 'clientId', client_id, 'status', status)` },
        sql`from apps where ${goes}`,
      ),
      // Its connections, tokens and codes go with it (`on delete cascade`).
      db.all<{ id: number }>(sql`delete from apps where ${goes} returning id`),
      db.all<{ status: AppStatus; reported: number }>(
        sql`select status, ${reported} as reported from apps where ${mine}`,
      ),
    ] as never)) as unknown as [
      unknown,
      { id: number }[],
      { status: AppStatus; reported: number }[],
    ]
    if (deleted.length > 0) return c.json({ ok: true })
    const still = left[0]
    if (!still) return refuse(c, 'not_found', 404)
    if (still.status === 'suspended') return refuse(c, 'cut_off', 409)
    return refuse(c, 'reported', 409)
  })

  return routes
}

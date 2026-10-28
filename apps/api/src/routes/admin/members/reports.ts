/**
 * The Reports area (ADR 0059): what members reported, one row per thing however many reported
 * it, and what an operator decided. Resolve says it was acted on, Dismiss that there was nothing
 * to do; either closes every open report of the thing at once, and an undo opens those again.
 * Acting on the thing itself is another area's action, offered beside it (hide a blog or a
 * blogroll from Discover, suspend or delete a member), each on the id that action takes.
 *
 * A row shows what anyone could see on the page it was reported from: a blogroll's name only
 * while it is public (as History names one), and a note only while it is not taken back. The
 * reporters are named in the record, to the operator alone: a report is between them.
 */
import { audit, historyOf, type TelaDb } from '@tela/data'
import {
  isReportTarget,
  REPORT_REASONS,
  type ReportKey,
  type ReportReason,
  type ReportState,
  type ReportTarget,
  reportKeyOf,
} from '@tela/shared'
import {
  ADMIN_LIST_LIMIT,
  type AdminActionName,
  type AdminList,
  type AdminReportDetail,
  type AdminReportEntry,
  type AdminReportRow,
  type AdminReportTarget,
  type AdminStanding,
  isAdminFilter,
  reportRowId,
} from '@tela/shared/admin'
import { type SQL, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import type { ApiDeps } from '../../../deps'
import { type ActHandler, type AdminEnv, type Inverse, returned, runBatch } from '../framework'
import { like, likePattern, personOf } from '../library/common'

/** What a note's label keeps of it: enough to recognise, never a page of it. */
const NOTE_LABEL_MAX = 160

/** A row id read back: the kind and key it names, or null for one no report could have. */
export function reportTargetOf(id: string): { kind: ReportTarget; key: string } | null {
  const at = id.indexOf(':')
  const kind = id.slice(0, at)
  const key = id.slice(at + 1)
  if (at <= 0 || !isReportTarget(kind) || !reportKeyOf(kind, key)) return null
  return { kind, key }
}

/** The member a report's key names, over `reports r`: the profile's, a note's author, a blogroll's owner. */
const MEMBER_OF = sql.raw(`(case r.target_kind
  when 'profile' then r.target_key
  when 'recommendation' then substr(r.target_key, 1, instr(r.target_key, ':') - 1)
  when 'blogroll' then (select b.user_id from blogrolls b where b.id = r.target_key)
  end)`)

/**
 * A search over what was reported, by its name (a member's handle or name, a blog's title or
 * address, a blogroll's name) or the words a reporter gave; everything without one.
 */
function reportMatches(q: string): SQL {
  if (!q.trim()) return sql`1`
  const p = likePattern(q.trim())
  return sql`(${like(sql`r.details`, p)} or exists (select 1 from profiles px
      where px.user_id = ${MEMBER_OF}
        and (${like(sql`px.handle`, p)} or ${like(sql`px.display_name`, p)}))
    or (r.target_kind = 'site' and exists (select 1 from sites sx
      where sx.id = cast(r.target_key as integer)
        and (${like(sql`sx.title`, p)} or ${like(sql`sx.home_url`, p)})))
    or (r.target_kind = 'blogroll' and exists (select 1 from blogrolls bx
      where bx.id = r.target_key and bx.is_public = 1 and ${like(sql`bx.name`, p)})))`
}

type GroupRaw = {
  kind: ReportTarget
  key: string
  reporters: number
  first_at: number
  last_at: number
  reasons: string
  reason: ReportReason
  details: string | null
  decided_at: number | null
  decided_id: string | null
  decided_handle: string | null
  decided_name: string | null
  open: number
}

/**
 * The things reported in `state`, each once, newest report first: how many members reported it
 * (one open report each; a reporter whose account is gone still counts), the reasons given, the
 * newest reason and words, and who decided it, for a row the operator closed.
 */
const groupsIn = (state: ReportState, where: SQL, limit: number) => sql`
  select r.target_kind as kind, r.target_key as key,
    count(distinct coalesce(r.reporter_id, '#' || r.id)) as reporters,
    min(r.created_at) as first_at, max(r.created_at) as last_at,
    json_group_array(distinct r.reason) as reasons,
    (select x.reason from reports x where x.target_kind = r.target_kind
      and x.target_key = r.target_key and x.state = ${state}
      order by x.created_at desc, x.id desc limit 1) as reason,
    (select x.details from reports x where x.target_kind = r.target_kind
      and x.target_key = r.target_key and x.state = ${state} and x.details is not null
      order by x.created_at desc, x.id desc limit 1) as details,
    max(r.resolved_at) as decided_at,
    d.user_id as decided_id, d.handle as decided_handle, d.display_name as decided_name,
    (select count(*) from reports x where x.target_kind = r.target_kind
      and x.target_key = r.target_key and x.state = 'open') as open
  from reports r
  left join profiles d on d.user_id = (select x.resolved_by from reports x
    where x.target_kind = r.target_kind and x.target_key = r.target_key and x.state = ${state}
    order by x.resolved_at desc, x.id desc limit 1)
  where r.state = ${state} and ${where}
  group by r.target_kind, r.target_key
  order by last_at desc, r.target_kind, r.target_key
  limit ${limit}`

const standingOf = (p: {
  suspended_at: number | null
  deleted_at: number | null
}): AdminStanding =>
  p.deleted_at !== null ? 'deleted' : p.suspended_at !== null ? 'suspended' : 'ok'

type PersonRaw = {
  user_id: string
  handle: string
  display_name: string | null
  is_admin: number
  suspended_at: number | null
  deleted_at: number | null
}

/** A member's actions on what they made: suspend or lift it, and delete. Never an admin's. */
function memberActions(p: PersonRaw): AdminReportTarget['actions'] {
  if (p.is_admin === 1 || p.deleted_at !== null) return []
  const id = p.user_id
  return [
    { action: p.suspended_at === null ? 'member.suspend' : 'member.unsuspend', id },
    { action: 'member.delete', id },
  ]
}

const memberOf = (p: PersonRaw) => ({
  id: p.user_id,
  handle: p.handle,
  name: p.display_name,
  standing: standingOf(p),
})

const PERSON = sql.raw(`p.user_id, p.handle, p.display_name, p.is_admin, p.suspended_at,
  p.deleted_at`)

/**
 * What each reported thing is now, read in one batch of one statement per kind, each taking its
 * keys as a single JSON parameter. A thing that is gone is named by its kind and key alone.
 */
export async function describeTargets(
  db: TelaDb,
  wanted: { kind: ReportTarget; key: string }[],
): Promise<Map<string, AdminReportTarget>> {
  // Every kind named, never cast: a kind missing here was a crash at runtime, not a type error.
  const keys: Record<ReportTarget, ReportKey[]> = {
    profile: [],
    blogroll: [],
    site: [],
    recommendation: [],
    app: [],
  }
  for (const w of wanted) {
    const key = reportKeyOf(w.kind, w.key)
    if (key) keys[w.kind].push(key)
  }
  const json = (values: unknown[]) => JSON.stringify(values)
  const none = sql`select 1 where false`
  const [profiles, blogrolls, sites, notes] = (await runBatch(db, [
    keys.profile.length
      ? db.all(sql`select ${PERSON} from profiles p where p.user_id in (select value
          from json_each(${json(keys.profile.map((k) => (k.kind === 'profile' ? k.userId : '')))}))`)
      : db.all(none),
    keys.blogroll.length
      ? db.all(sql`select b.id, b.name, b.is_public, b.deleted_at as gone_at, b.hidden_at, ${PERSON}
          from blogrolls b join profiles p on p.user_id = b.user_id
          where b.id in (select value from json_each(${json(
            keys.blogroll.map((k) => (k.kind === 'blogroll' ? k.blogrollId : '')),
          )}))`)
      : db.all(none),
    keys.site.length
      ? db.all(sql`select s.id, coalesce(s.title, s.home_url) as label, s.listing from sites s
          where s.id in (select value from json_each(${json(
            keys.site.map((k) => (k.kind === 'site' ? k.siteId : 0)),
          )}))`)
      : db.all(none),
    keys.recommendation.length
      ? db.all(sql`select json_extract(j.value, '$[0]') as note_user, json_extract(j.value, '$[1]') as note_article,
          r.note, r.deleted_at as taken_at, ${PERSON}
          from json_each(${json(
            keys.recommendation.map((k) =>
              k.kind === 'recommendation' ? [k.userId, k.articleId] : [],
            ),
          )}) j
          join profiles p on p.user_id = json_extract(j.value, '$[0]')
          left join recommendations r on r.user_id = p.user_id
            and r.article_id = json_extract(j.value, '$[1]')`)
      : db.all(none),
  ])) as Record<string, unknown>[][]

  const out = new Map<string, AdminReportTarget>()
  const blank = (kind: ReportTarget, key: string): AdminReportTarget => ({
    kind,
    key,
    label: null,
    path: null,
    member: null,
    siteId: null,
    actions: [],
  })
  for (const w of wanted) out.set(reportRowId(w.kind, w.key), blank(w.kind, w.key))

  for (const raw of profiles ?? []) {
    const p = raw as unknown as PersonRaw
    const standing = standingOf(p)
    out.set(reportRowId('profile', p.user_id), {
      ...blank('profile', p.user_id),
      label: p.display_name || `@${p.handle}`,
      path: standing === 'ok' ? `/@${p.handle}` : null,
      member: memberOf(p),
      actions: memberActions(p),
    })
  }
  for (const raw of blogrolls ?? []) {
    const b = raw as unknown as PersonRaw & {
      id: string
      name: string
      is_public: number
      gone_at: number | null
      hidden_at: number | null
    }
    const shown = b.is_public === 1 && b.gone_at === null
    out.set(reportRowId('blogroll', b.id), {
      ...blank('blogroll', b.id),
      // Named only while others can open it, as History names one: a private blogroll is its
      // member's alone.
      label: shown ? b.name : null,
      path: shown && standingOf(b) === 'ok' ? `/l/${b.id}` : null,
      member: memberOf(b),
      actions: [
        ...(shown && b.hidden_at === null ? [{ action: 'blogroll.hide' as const, id: b.id }] : []),
        ...memberActions(b),
      ],
    })
  }
  for (const raw of sites ?? []) {
    const s = raw as { id: number; label: string; listing: string }
    const listed = s.listing === 'listed' || s.listing === 'featured'
    out.set(reportRowId('site', String(s.id)), {
      ...blank('site', String(s.id)),
      label: s.label,
      path: listed ? `/s/${s.id}` : null,
      siteId: s.id,
      actions: s.listing !== 'rejected' ? [{ action: 'site.hide', id: String(s.id) }] : [],
    })
  }
  for (const raw of notes ?? []) {
    const n = raw as unknown as PersonRaw & {
      note_user: string
      note_article: number
      note: string | null
      taken_at: number | null
    }
    const live = n.note !== null && n.note !== '' && n.taken_at === null
    const key = `${n.note_user}:${n.note_article}`
    const text = live ? [...(n.note ?? '')] : []
    out.set(reportRowId('recommendation', key), {
      ...blank('recommendation', key),
      label: live
        ? text.length > NOTE_LABEL_MAX
          ? `${text.slice(0, NOTE_LABEL_MAX - 1).join('')}…`
          : text.join('')
        : null,
      // The note shows on its author's profile, under Recommendations.
      path: live && standingOf(n) === 'ok' ? `/@${n.handle}` : null,
      member: memberOf(n),
      actions: memberActions(n),
    })
  }
  return out
}

function parseReasons(json: string): ReportReason[] {
  try {
    const list = JSON.parse(json) as unknown
    return Array.isArray(list) ? REPORT_REASONS.filter((reason) => list.includes(reason)) : []
  } catch {
    return []
  }
}

function toRow(
  g: GroupRaw,
  state: ReportState,
  targets: Map<string, AdminReportTarget>,
): AdminReportRow {
  const id = reportRowId(g.kind, g.key)
  return {
    id,
    // Resolve and Dismiss close what is open of it, from any filter it shows in.
    actions: g.open > 0 ? ['report.resolve', 'report.dismiss'] : [],
    target: targets.get(id) ?? {
      kind: g.kind,
      key: g.key,
      label: null,
      path: null,
      member: null,
      siteId: null,
      actions: [],
    },
    state,
    reason: g.reason,
    reasons: parseReasons(g.reasons),
    details: g.details,
    reporters: Number(g.reporters),
    firstAt: Number(g.first_at),
    lastAt: Number(g.last_at),
    decidedAt: state === 'open' || g.decided_at === null ? null : Number(g.decided_at),
    decidedBy: state === 'open' ? null : personOf(g.decided_id, g.decided_handle, g.decided_name),
  }
}

async function rowsOf(db: TelaDb, state: ReportState, groups: GroupRaw[]) {
  const targets = await describeTargets(db, groups)
  return groups.map((g) => toRow(g, state, targets))
}

/** Close every open report of one thing: `resolved` (acted on) or `dismissed` (nothing to do). */
function decide(action: 'report.resolve' | 'report.dismiss', state: ReportState): ActHandler {
  return async (ctx, id) => {
    const target = reportTargetOf(id)
    if (!target) return 'not_found'
    const { db } = ctx.deps
    const of = sql`target_kind = ${target.kind} and target_key = ${target.key}`
    const open = sql`${of} and state = 'open'`
    const results = await runBatch(db, [
      audit(
        db,
        {
          group: ctx.group,
          actor: ctx.actor,
          action,
          targetKind: 'report',
          targetKey: id,
          at: ctx.now,
        },
        {
          from: sql`json_object('ids', json(x.ids), 'state', 'open')`,
          to: { state, at: ctx.now },
        },
        sql`from (select json_group_array(id) as ids, count(*) as n from reports where ${open}) x
          where x.n > 0`,
      ),
      db.all(sql`update reports set state = ${state}, resolved_at = ${ctx.now},
          resolved_by = ${ctx.actor}
        where ${open} returning id`),
      db.all(sql`select id from reports where ${of} limit 1`),
    ])
    if (returned(results[1]).length > 0) return 'done'
    return returned(results[2]).length > 0 ? 'not_applicable' : 'not_found'
  }
}

/**
 * Open again the reports a decision closed, while each still holds it. A member who has reported
 * the thing again since keeps that one report open; their earlier one stays closed.
 */
const reopen: Inverse = (db, change) => {
  const from = (change.from ?? {}) as { ids?: unknown }
  const to = (change.to ?? {}) as { state?: string; at?: number }
  const ids = JSON.stringify(Array.isArray(from.ids) ? from.ids : [])
  const holds = sql`r.state = ${to.state ?? ''} and r.resolved_at = ${to.at ?? -1}`
  return {
    changed: sql`exists (select 1 from json_each(${ids}) j where not exists (
      select 1 from reports r where r.id = j.value and ${holds}))`,
    restore: [
      db.run(sql`update reports set state = 'open', resolved_at = null, resolved_by = null
        where id in (select value from json_each(${ids}))
          and state = ${to.state ?? ''} and resolved_at = ${to.at ?? -1}
          and not exists (select 1 from reports o where o.state = 'open'
            and o.reporter_id = reports.reporter_id and o.target_kind = reports.target_kind
            and o.target_key = reports.target_key)`),
    ],
    synced: false,
  }
}

export const reportActions = {
  'report.resolve': decide('report.resolve', 'resolved'),
  'report.dismiss': decide('report.dismiss', 'dismissed'),
} satisfies Partial<Record<AdminActionName, ActHandler>>

export const reportInverses = {
  'report.resolve': reopen,
  'report.dismiss': reopen,
} satisfies Partial<Record<AdminActionName, Inverse>>

/** How many things wait in the queue, for the sidebar's badge. */
export const OPEN_REPORTS = sql.raw(
  `(select count(*) from (select 1 from reports where state = 'open'
    group by target_kind, target_key))`,
)

/** `GET /reports?f=&q=` and `GET /reports/:id`, where the id is `<kind>:<key>`. */
export function reportRoutes(deps: ApiDeps) {
  const { db } = deps
  const routes = new Hono<AdminEnv>()

  routes.get('/reports', async (c) => {
    const f = c.req.query('f') ?? 'open'
    const q = c.req.query('q') ?? ''
    if (!isAdminFilter('reports', f) || q.length > 200) return c.json({ error: 'invalid' }, 400)
    const matches = reportMatches(q)
    const [counts, groups] = (await runBatch(db, [
      db.all(sql`select r.state, count(distinct r.target_kind || ':' || r.target_key) as n
        from reports r where ${matches} group by r.state`),
      db.all(groupsIn(f, matches, ADMIN_LIST_LIMIT + 1)),
    ])) as [{ state: ReportState; n: number }[], GroupRaw[]]
    const count = (state: ReportState) => Number(counts.find((r) => r.state === state)?.n ?? 0)
    const answer: AdminList<AdminReportRow, 'reports'> = {
      counts: { open: count('open'), resolved: count('resolved'), dismissed: count('dismissed') },
      rows: await rowsOf(db, f, groups.slice(0, ADMIN_LIST_LIMIT)),
      truncated: groups.length > ADMIN_LIST_LIMIT,
    }
    return c.json(answer)
  })

  routes.get('/reports/:id', async (c) => {
    const id = c.req.param('id')
    const target = reportTargetOf(id)
    if (!target) return c.json({ error: 'not_found' }, 404)
    const of = sql`r.target_kind = ${target.kind} and r.target_key = ${target.key}`
    const entries = await db.all<{
      id: number
      reason: ReportReason
      details: string | null
      url: string | null
      created_at: number
      state: ReportState
      user_id: string | null
      handle: string | null
      display_name: string | null
    }>(sql`
      select r.id, r.reason, r.details, r.url, r.created_at, r.state, p.user_id, p.handle,
        p.display_name
      from reports r left join profiles p on p.user_id = r.reporter_id
      where ${of} order by r.created_at desc, r.id desc limit 200
    `)
    const newest = entries[0]
    if (!newest) return c.json({ error: 'not_found' }, 404)
    // The row as the open queue shows it while anything is open, else as its latest decision.
    const state: ReportState = entries.some((e) => e.state === 'open') ? 'open' : newest.state
    const groups = await db.all<GroupRaw>(groupsIn(state, of, 1))
    const [row] = await rowsOf(db, state, groups)
    if (!row) return c.json({ error: 'not_found' }, 404)
    const answer: AdminReportDetail = {
      report: row,
      reports: entries.map(
        (e): AdminReportEntry => ({
          id: e.id,
          reason: e.reason,
          details: e.details,
          url: e.url,
          at: e.created_at,
          state: e.state,
          reporter: personOf(e.user_id, e.handle, e.display_name),
        }),
      ),
      history: await historyOf(db, 'report', id),
    }
    return c.json(answer)
  })

  return routes
}

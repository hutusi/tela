/**
 * A member reports something public (ADR 0059): a profile, a blogroll, a blog's page or a note
 * beside a recommendation. `POST /api/v1/reports {targetKind, targetKey, reason, details?, url?}`.
 *
 * Only what anyone can see is reportable, and only while they can: a private blogroll, an unlisted
 * blog, a suspended member's profile or a note taken back is a 404, as its page is. One open report
 * per member per thing: a second while the first is open changes nothing, and is answered as the
 * first was, so the answer never says whether anyone, the member included, reported it before.
 * Counted per member (`report`), repeats too.
 */
import { consumeLimit, isShown, standingOk } from '@tela/data'
import {
  isReportReason,
  isReportTarget,
  REPORT_DETAILS_MAX,
  type ReportKey,
  reportKeyOf,
} from '@tela/shared'
import { type SQL, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import type { ApiEnv } from '../app'
import type { ApiDeps } from '../deps'
import { PUBLIC_LISTING } from './public-sql'

/** The longest page address kept beside a report: a public page's is far shorter. */
export const REPORT_URL_MAX = 1000

/** Control characters, which no reason a person types holds; a line break is allowed. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: the point is to find them
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/

/**
 * A query that finds one row while the thing a report names is shown to anyone: a member in good
 * standing; a public, live blogroll of one; a blog with a public page; a live note of one. The
 * same rules its public page answers by, so a report is never refused for what a visitor can see,
 * nor taken for what nobody can.
 */
export function shownTarget(key: ReportKey): SQL {
  switch (key.kind) {
    case 'profile':
      return sql`select 1 from profiles p where p.user_id = ${key.userId} and ${standingOk('p')}`
    case 'blogroll':
      return sql`select 1 from blogrolls r join profiles p on p.user_id = r.user_id
        where r.id = ${key.blogrollId} and ${isShown('r')} and ${standingOk('p')}`
    case 'site':
      return sql`select 1 from sites s where s.id = ${key.siteId} and s.listing in ${PUBLIC_LISTING}`
    case 'recommendation':
      return sql`select 1 from recommendations r join profiles p on p.user_id = r.user_id
        where r.user_id = ${key.userId} and r.article_id = ${key.articleId}
          and r.deleted_at is null and r.note is not null and r.note <> '' and ${standingOk('p')}`
  }
}

type Body = {
  targetKind?: unknown
  targetKey?: unknown
  reason?: unknown
  details?: unknown
  url?: unknown
}

/** The report a body asks for, or null when it is not one. Empty words are no words. */
export function parseReport(body: Body | null) {
  if (typeof body !== 'object' || body === null) return null
  const { targetKind, targetKey, reason } = body
  if (!isReportTarget(targetKind) || typeof targetKey !== 'string') return null
  const key = reportKeyOf(targetKind, targetKey)
  if (!key || !isReportReason(reason)) return null
  let details: string | null = null
  if (body.details !== undefined && body.details !== null) {
    if (typeof body.details !== 'string') return null
    const trimmed = body.details.trim()
    // In code points, as SQLite's `length()` and the table's check count them.
    if ([...trimmed].length > REPORT_DETAILS_MAX || CONTROL.test(trimmed)) return null
    details = trimmed === '' ? null : trimmed
  }
  let url: string | null = null
  if (body.url !== undefined && body.url !== null) {
    if (typeof body.url !== 'string' || body.url.length > REPORT_URL_MAX) return null
    if (!/^https?:\/\/[^\s]+$/i.test(body.url)) return null
    url = body.url
  }
  return { kind: targetKind, key: targetKey, target: key, reason, details, url }
}

export function reportRoutes(deps: ApiDeps) {
  const { db } = deps
  const routes = new Hono<ApiEnv>()

  routes.post('/', async (c) => {
    const report = parseReport(await c.req.json<Body>().catch(() => null))
    if (!report) return c.json({ error: 'invalid' }, 400)
    const me = c.get('member').id
    const now = deps.clock.now()
    const limited = await consumeLimit(db, 'report', me, now)
    if (!limited.allowed) {
      return c.json({ error: 'rate_limited' }, 429, {
        'retry-after': String(limited.retryAfterSec),
      })
    }
    const shown = shownTarget(report.target)
    const [found] = (await db.batch([
      db.all(sql`select exists (${shown}) as shown`),
      db.run(sql`
        insert into reports (reporter_id, target_kind, target_key, reason, details, url, state,
          created_at)
        select ${me}, ${report.kind}, ${report.key}, ${report.reason}, ${report.details},
          ${report.url}, 'open', ${now}
        where exists (${shown}) and not exists (
          select 1 from reports where reporter_id = ${me} and target_kind = ${report.kind}
            and target_key = ${report.key} and state = 'open')
      `),
    ] as never)) as unknown as [{ shown: number }[]]
    if (found?.[0]?.shown !== 1) return c.json({ error: 'not_found' }, 404)
    return c.json({ ok: true }, 200, { 'cache-control': 'no-store' })
  })

  return routes
}

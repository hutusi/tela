/**
 * The Overview (ADR 0039) and the sidebar's badges: the health check live, the queues that wait
 * on an operator with the first few of each, this week against the week before, and what
 * operators did lately.
 */
import { recentActivity, type TelaDb } from '@tela/data'
import type { AdminCounts, AdminOverview } from '@tela/shared/admin'
import { sql } from 'drizzle-orm'
import { Hono } from 'hono'
import type { ApiDeps } from '../../../deps'
import type { AdminEnv } from '../framework'
import { runBatch } from '../framework'
import { auditedLabel, lookUp, wantAudited, wanted, wantJob } from './names'
import {
  CLAIM_NEEDS_REVIEW,
  claimRows,
  DEAD_UNRESOLVED,
  DISCOVER_CANDIDATE,
  deadRows,
  FEED_FAILING,
  feedRows,
  siteRows,
  toClaimRow,
  toDeadRow,
  toFeedRow,
  toSiteRow,
} from './rows'
import { liveHealth } from './system'

const DAY = 86_400_000
/** How many of each queue the Overview shows; the queue's own ledger has the rest. */
const QUEUE_ROWS = 3

type Row = Record<string, unknown>

/** What waits in each queue: one statement, so the badges agree with each other. */
const queueCounts = (db: TelaDb) =>
  db.all(sql`
    select
      (select count(*) from site_claims c where ${CLAIM_NEEDS_REVIEW}) as claims,
      (select count(*) from feeds f where ${FEED_FAILING}) as feeds,
      (select count(*) from dead_letters d where ${DEAD_UNRESOLVED}) as dead,
      (select count(*) from sites s where ${DISCOVER_CANDIDATE}) as candidates
  `)

async function counts(db: TelaDb): Promise<AdminCounts> {
  const row = ((await queueCounts(db)) as Row[])[0] ?? {}
  return {
    claims: Number(row.claims ?? 0),
    feeds: Number(row.feeds ?? 0),
    dead: Number(row.dead ?? 0),
  }
}

/** This week and the week before: rolling seven days, so Monday's figures are not a day's. */
function weekly(db: TelaDb, now: number) {
  const a = now - 7 * DAY
  const b = now - 14 * DAY
  const pair = (name: string, table: string, column: string, value = 'count(*)') => {
    const from = sql.raw(`select ${value} from ${table} where ${column}`)
    const col = sql.raw(column)
    return sql`(${from} > ${a}) as ${sql.raw(`${name}_0`)},
      (${from} > ${b} and ${col} <= ${a}) as ${sql.raw(`${name}_1`)}`
  }
  return db.all(sql`
    select ${pair('members', 'user', 'created_at')},
      ${pair('claims', 'site_claims', 'verified_at')},
      ${pair('feeds', 'feeds', 'created_at')},
      ${pair('tokens', 'llm_calls', 'created_at', 'coalesce(sum(input_tokens + output_tokens), 0)')}
  `)
}

async function overview(deps: ApiDeps, now: number): Promise<AdminOverview> {
  const { db } = deps
  const [h, activity, results] = await Promise.all([
    liveHealth(db, deps.blobs, now),
    recentActivity(db, 12),
    runBatch(db, [
      queueCounts(db),
      claimRows(db, now, CLAIM_NEEDS_REVIEW, sql`c.last_checked_at desc, c.id desc`, QUEUE_ROWS),
      feedRows(db, FEED_FAILING, sql`f.error_count desc, f.timeout_streak desc, f.id`, QUEUE_ROWS),
      deadRows(db, DEAD_UNRESOLVED, sql`d.at desc, d.id desc`, QUEUE_ROWS),
      siteRows(db, DISCOVER_CANDIDATE, sql`s.reader_count desc, s.id`, QUEUE_ROWS),
      weekly(db, now),
    ]),
  ])
  const [counted, claims, feeds, dead, candidates, week] = results as Row[][]
  const w = wanted()
  for (const r of dead ?? []) wantJob(w, String(r.kind), String(r.key))
  for (const entry of activity) wantAudited(w, entry)
  const names = await lookUp(db, w)
  const n = (counted ?? [])[0] ?? {}
  const figures = (week ?? [])[0] ?? {}
  const at = (name: string): [number, number] => [
    Number(figures[`${name}_0`] ?? 0),
    Number(figures[`${name}_1`] ?? 0),
  ]
  return {
    health: h,
    queues: {
      claims: {
        count: Number(n.claims ?? 0),
        rows: (claims ?? []).map((r) =>
          toClaimRow(r, ['claim.recheck', 'claim.vouch', 'claim.reject', 'claim.dismiss']),
        ),
      },
      feeds: {
        count: Number(n.feeds ?? 0),
        rows: (feeds ?? []).map((r) => toFeedRow(r, ['feed.fetch', 'feed.pause'])),
      },
      dead: {
        count: Number(n.dead ?? 0),
        rows: (dead ?? []).map((r) => toDeadRow(r, names)),
      },
      candidates: {
        count: Number(n.candidates ?? 0),
        rows: (candidates ?? []).map((r) =>
          toSiteRow(r, ['site.feature', 'site.list', 'site.hide']),
        ),
      },
    },
    week: {
      members: at('members'),
      claimsVerified: at('claims'),
      feedsAdded: at('feeds'),
      tokens: at('tokens'),
    },
    activity: activity.map((entry) => ({ ...entry, label: auditedLabel(names, entry) })),
  }
}

export function overviewRoutes(deps: ApiDeps) {
  const routes = new Hono<AdminEnv>()
  routes.get('/counts', async (c) => c.json(await counts(deps.db)))
  routes.get('/overview', async (c) => c.json(await overview(deps, deps.clock.now())))
  return routes
}

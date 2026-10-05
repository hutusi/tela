/**
 * Is Tela getting its work done (ADR 0027)? Feeds long past due, a body translation stuck,
 * extraction piling up, a burst of dead letters nobody has dealt with, or a backup that is stale
 * or failed its check. tela-jobs asks every few minutes and tells the dead-man's switch; the admin
 * console asks live (ADR 0039), which is why the check lives here rather than in tela-jobs.
 *
 * And what each periodic run last reported about itself (`ops_heartbeats`): the tick, the daily
 * sweep, the digest and the health check each leave a line, so the console can say when each
 * last ran and with what.
 */

import type { Blobs } from '@tela/platform'
import type { HealthCheck, HealthCheckName } from '@tela/shared/admin'
import { sql } from 'drizzle-orm'
import { latestBackup } from './backup'
import type { TelaDb } from './db'

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

/**
 * The answer. `problems` are the lines the dead-man's switch is sent when something is wrong
 * (English, for the operator's inbox); `checks` are the same questions as data, one per
 * `HEALTH_CHECKS` name and in that order, for the console to put in its own words.
 */
export type Health = { ok: boolean; problems: string[]; checks: HealthCheck[] }

/** Past these, something is wrong rather than merely busy. */
export const THRESHOLDS = {
  overdueFeeds: 3,
  deadLettersPerDay: 20,
  extractionBacklog: 20,
  backupAgeHours: 36,
} as const

const count = (rows: unknown) => Number((rows as { n: number }[])[0]?.n ?? 0)

export async function health(db: TelaDb, blobs: Blobs, now: number): Promise<Health> {
  const [overdue, dead, stuck, extraction] = (await db.batch([
    // Due for two hours and nobody working on it: the sweeps are not keeping up, or not running.
    db.all(sql`
      select count(*) as n from feeds f
      where f.status = 'active' and f.next_fetch_at < ${now - 2 * HOUR}
        and not exists (select 1 from leases l where l.kind = 'feed.fetch'
          and l.key = cast(f.id as text) and l.until > ${now})
    `),
    // Only the ones nobody has dealt with: an operator who retried or dismissed a burst in the
    // console has answered it, and the check would otherwise stay red for the rest of the day.
    db.all(sql`
      select count(*) as n from dead_letters where at > ${now - DAY} and resolved_at is null
    `),
    // A reader is waiting on these.
    db.all(sql`
      select count(*) as n from body_translations
      where state in ('requested', 'running') and updated_at < ${now - 30 * MIN}
    `),
    db.all(sql`
      select count(*) as n from articles where extract_state = 'due' and fetched_at < ${now - 6 * HOUR}
    `),
  ] as never)) as unknown as unknown[][]
  const backup = await latestBackup(blobs).catch(() => null)
  const problems: string[] = []
  const checks: HealthCheck[] = []
  const check = (name: HealthCheckName, value: number | null, limit: number | null, ok: boolean) =>
    checks.push({ name, value, limit, ok })

  const overdueN = count(overdue)
  check('overdueFeeds', overdueN, THRESHOLDS.overdueFeeds, overdueN <= THRESHOLDS.overdueFeeds)
  if (overdueN > THRESHOLDS.overdueFeeds)
    problems.push(`${overdueN} feeds are more than two hours past due`)

  const deadN = count(dead)
  check('deadLetters', deadN, THRESHOLDS.deadLettersPerDay, deadN <= THRESHOLDS.deadLettersPerDay)
  if (deadN > THRESHOLDS.deadLettersPerDay)
    problems.push(`${deadN} jobs were dead-lettered in the last day`)

  const stuckN = count(stuck)
  check('stuckBodies', stuckN, 0, stuckN === 0)
  if (stuckN > 0) problems.push(`${stuckN} body translations have been waiting over 30 minutes`)

  const extractionN = count(extraction)
  const extractionOk = extractionN <= THRESHOLDS.extractionBacklog
  check('extractionBacklog', extractionN, THRESHOLDS.extractionBacklog, extractionOk)
  if (!extractionOk)
    problems.push(`${extractionN} articles have waited over six hours for their full text`)

  // No backup yet is a new deployment, not a failure; the first nightly run writes one.
  const ageMs = backup ? now - backup.finishedAt : null
  const fresh = ageMs === null || ageMs <= THRESHOLDS.backupAgeHours * HOUR
  check(
    'backupAge',
    ageMs === null ? null : Math.max(0, Math.floor(ageMs / HOUR)),
    THRESHOLDS.backupAgeHours,
    fresh,
  )
  if (backup && !fresh) problems.push(`the last backup is from ${backup.date}`)
  check(
    'backupVerified',
    backup ? (backup.verified ? 1 : 0) : null,
    null,
    !backup || backup.verified,
  )
  if (backup && !backup.verified) problems.push(`the ${backup.date} backup failed its check`)

  return { ok: problems.length === 0, problems, checks }
}

/** The periodic runs that leave a heartbeat. */
export const HEARTBEATS = ['tick', 'daily', 'digest', 'health'] as const
export type HeartbeatName = (typeof HEARTBEATS)[number]

/** Record that a periodic run finished, and what it saw; the latest of each name is kept. */
export function heartbeat(db: TelaDb, name: HeartbeatName, at: number, info: unknown) {
  return db.run(sql`
    insert into ops_heartbeats (name, at, info) values (${name}, ${at}, ${JSON.stringify(info ?? {})})
    on conflict (name) do update set at = excluded.at, info = excluded.info
  `)
}

export type Heartbeat = { at: number; info: Record<string, unknown> }

/** Every run's latest heartbeat, by name; a run that never reported is absent. */
export async function heartbeats(db: TelaDb): Promise<Partial<Record<HeartbeatName, Heartbeat>>> {
  const rows = await db.all<{ name: HeartbeatName; at: number; info: string }>(
    sql`select name, at, info from ops_heartbeats`,
  )
  const beats: Partial<Record<HeartbeatName, Heartbeat>> = {}
  for (const row of rows) {
    let info: Record<string, unknown> = {}
    try {
      const parsed = JSON.parse(row.info) as unknown
      if (parsed && typeof parsed === 'object') info = parsed as Record<string, unknown>
    } catch {}
    beats[row.name] = { at: row.at, info }
  }
  return beats
}

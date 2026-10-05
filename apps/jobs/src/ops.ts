/**
 * Keeping Tela running without watching it (ADR 0027).
 *
 * - `health` (in `@tela/data`, which the admin console asks too) is asked every few minutes after
 *   the tick: is work getting done? `checkHealth` keeps its answer as a heartbeat and tells the
 *   dead-man's switch.
 * - `pingDeadman` reports that answer to an outside dead-man's switch (healthchecks.io's
 *   convention: the URL when healthy, `/fail` with the problems when not). Silence is the alarm
 *   for everything that stops the tick itself: a broken deploy, an account problem, D1 down.
 * - `nightly` is the daily cron: the sweep, the export and its pruning.
 * - `digest` is the Monday mail to the owner: what a week of running looked like.
 *
 * Each periodic run leaves a heartbeat (`ops_heartbeats`), so the console can say when it last
 * ran and what it saw. The cron handlers in `worker.ts` only call these, so the suite runs them.
 */
import {
  backUp,
  type Health,
  health,
  heartbeat,
  latestBackup,
  pruneBackups,
  type TelaDb,
  utcDay,
} from '@tela/data'
import type { Blobs, Mail } from '@tela/platform'
import { sql } from 'drizzle-orm'
import { type DailyReport, daily } from './daily'

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

/** Exports kept (ADR 0027); D1's Time Travel covers the last 30 days point in time as well. */
export const BACKUP_KEEP_DAYS = 30

const count = (rows: unknown) => Number((rows as { n: number }[])[0]?.n ?? 0)

/**
 * The health check as the tick runs it every fifth minute: asked, kept as the `health` heartbeat
 * (so the console can say when it last ran and what the switch was told), and reported.
 */
export async function checkHealth(
  db: TelaDb,
  blobs: Blobs,
  now: number,
  deadmanUrl: string | undefined,
  doFetch: typeof fetch = fetch,
): Promise<Health> {
  const h = await health(db, blobs, now)
  await heartbeat(db, 'health', now, { ok: h.ok, problems: h.problems })
  await pingDeadman(deadmanUrl, h, doFetch)
  return h
}

export type NightlyReport = {
  report: DailyReport
  backup: Awaited<ReturnType<typeof backUp>> | { error: string }
  pruned: number
}

/**
 * The daily cron (03:17 UTC): the sweep, then the export. A failed export leaves latest.json as
 * it was; the health check flags it once stale. The heartbeat says what the run did, the export's
 * outcome without its problems (the backup's own record keeps those).
 */
export async function nightly(db: TelaDb, blobs: Blobs, now: () => number): Promise<NightlyReport> {
  const at = now()
  const report = await daily(db, at)
  const date = utcDay(at)
  const backup = await backUp(db, blobs, { date, now }).catch((err: unknown) => ({
    error: String(err),
  }))
  const pruned = await pruneBackups(blobs, date, BACKUP_KEEP_DAYS)
  await heartbeat(db, 'daily', now(), {
    ...report,
    backup:
      'error' in backup
        ? { error: backup.error.slice(0, 200) }
        : { date: backup.date, rows: backup.rows, verified: backup.verified },
    pruned,
  })
  return { report, backup, pruned }
}

/**
 * The Monday digest: built, sent when there is somewhere to send it, and remembered as the
 * `digest` heartbeat. A send that throws leaves no heartbeat, so the console shows the last one
 * that went out.
 */
export async function weekly(
  db: TelaDb,
  blobs: Blobs,
  now: number,
  outbox?: { mail: Mail; to: string },
): Promise<{ sent: boolean; subject: string; text: string }> {
  const mail = await digest(db, blobs, now)
  if (outbox) await outbox.mail.send({ to: outbox.to, ...mail })
  await heartbeat(db, 'digest', now, { sent: Boolean(outbox), subject: mail.subject })
  return { sent: Boolean(outbox), ...mail }
}

/** Tell the dead-man's switch. Its failure is not ours to report: the next ping tries again. */
export async function pingDeadman(
  url: string | undefined,
  h: Pick<Health, 'ok' | 'problems'>,
  doFetch: typeof fetch = fetch,
) {
  if (!url) return
  const target = h.ok ? url : `${url.replace(/\/+$/, '')}/fail`
  await doFetch(target, {
    method: 'POST',
    body: h.ok ? 'ok' : h.problems.join('\n'),
    signal: AbortSignal.timeout(5000),
  }).catch(() => undefined)
}

type Row = Record<string, unknown>

/** The Monday mail, as text: what the last week of running looked like. */
export async function digest(
  db: TelaDb,
  blobs: Blobs,
  now: number,
): Promise<{ subject: string; text: string }> {
  const since = now - 7 * DAY
  const [
    statuses,
    failing,
    deadByKind,
    deadResolved,
    deadLatest,
    llm,
    posts,
    members,
    active,
    slow,
  ] = (await db.batch([
    db.all(sql`select status, count(*) as n from feeds group by status order by status`),
    db.all(sql`
        select feed_url as url, status, error_count as errors, last_error as error from feeds
        where error_count > 0 or status = 'dead' order by error_count desc limit 15
      `),
    db.all(
      sql`select kind, count(*) as n from dead_letters where at > ${since} group by kind order by n desc`,
    ),
    // Retried or dismissed in the admin console since (ADR 0039).
    db.all(
      sql`select count(*) as n from dead_letters where at > ${since} and resolved_at is not null`,
    ),
    db.all(
      sql`select kind, key, error from dead_letters where at > ${since} order by at desc limit 5`,
    ),
    db.all(sql`
        select job, model, count(*) as calls, sum(input_tokens) as input, sum(output_tokens) as output
        from llm_calls where created_at > ${since} group by job, model order by input desc
      `),
    db.all(sql`select count(*) as n from articles where fetched_at > ${since}`),
    db.all(sql`select count(*) as n from user`),
    db.all(sql`select count(distinct user_id) as n from session where updated_at > ${since}`),
    // Feeds Cloudflare cannot reach: the evidence for provisioning the relay (OPERATIONS.md).
    db.all(
      sql`select feed_url as url, timeout_streak as streak from feeds where timeout_streak >= 3`,
    ),
  ] as never)) as unknown as Row[][]
  const size = await db
    .all<{ bytes: number }>(
      sql`select page_count * page_size as bytes from pragma_page_count(), pragma_page_size()`,
    )
    .then((rows) => Number(rows[0]?.bytes ?? 0))
    .catch(() => null)
  const now_ = await health(db, blobs, now)
  const backup = await latestBackup(blobs).catch(() => null)
  const sum = (rows: Row[] | undefined, key: string) =>
    (rows ?? []).reduce((n, r) => n + Number(r[key] ?? 0), 0)
  const deadTotal = sum(deadByKind, 'n')
  const failingCount = (failing ?? []).length
  const lines: string[] = []
  const section = (title: string, body: string[]) =>
    lines.push('', title, ...body.map((l) => `  ${l}`))

  lines.push(
    now_.ok ? 'Everything the health check looks at is fine.' : 'The health check sees problems:',
  )
  for (const p of now_.problems) lines.push(`  - ${p}`)
  section('Reading', [
    `${count(posts)} new posts this week`,
    `${count(members)} members, ${count(active)} signed in this week`,
  ])
  section('Feeds', [
    (statuses ?? []).map((r) => `${r.n} ${r.status}`).join(', ') || 'none',
    ...(failing ?? []).map(
      (r) =>
        `${r.status === 'dead' ? 'dead' : `${r.errors} errors`}: ${r.url} (${String(r.error ?? '').slice(0, 120)})`,
    ),
  ])
  const resolved = count(deadResolved)
  section('Dead letters this week', [
    deadTotal === 0 ? 'none' : (deadByKind ?? []).map((r) => `${r.n} ${r.kind}`).join(', '),
    ...(deadTotal === 0 ? [] : [`${resolved} of them resolved in the admin console`]),
    ...(deadLatest ?? []).map((r) => `${r.kind} ${r.key}: ${String(r.error ?? '').slice(0, 120)}`),
  ])
  section('Model use this week', [
    (llm ?? []).length === 0
      ? 'none'
      : `${sum(llm, 'input')} input and ${sum(llm, 'output')} output tokens in ${sum(llm, 'calls')} calls`,
    ...(llm ?? []).map(
      (r) => `${r.job} on ${r.model}: ${r.calls} calls, ${r.input} in, ${r.output} out`,
    ),
  ])
  section('Storage', [
    size === null ? 'database size unknown' : `database ${(size / 1024 / 1024).toFixed(1)} MB`,
    backup
      ? `last backup ${backup.date}: ${backup.rows} rows, ${backup.verified ? 'verified' : `NOT verified (${backup.problems.join('; ')})`}`
      : 'no backup yet',
  ])
  if ((slow ?? []).length > 0) {
    section(
      'Feeds Cloudflare cannot reach (the case for the relay)',
      (slow ?? []).map((r) => `${r.url}: ${r.streak} timeouts in a row`),
    )
  }
  const subject = `Tela weekly: ${count(posts)} new posts, ${failingCount} failing feeds, ${deadTotal} dead letters${
    now_.ok ? '' : ' — needs a look'
  }`
  return { subject, text: `${lines.join('\n').trim()}\n` }
}

/**
 * Keeping Tela running without watching it (ADR 0027).
 *
 * - `health` is asked every few minutes after the tick: is work getting done? Feeds long past
 *   due, a body translation stuck, extraction piling up, a burst of dead letters, or a backup
 *   that is stale or failed its check.
 * - `pingDeadman` reports that answer to an outside dead-man's switch (healthchecks.io's
 *   convention: the URL when healthy, `/fail` with the problems when not). Silence is the alarm
 *   for everything that stops the tick itself: a broken deploy, an account problem, D1 down.
 * - `digest` is the Monday mail to the owner: what a week of running looked like.
 */
import { latestBackup, type TelaDb } from '@tela/data'
import type { Blobs } from '@tela/platform'
import { sql } from 'drizzle-orm'

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

export type Health = { ok: boolean; problems: string[] }

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
    db.all(sql`select count(*) as n from dead_letters where at > ${now - DAY}`),
    // A reader is waiting on these.
    db.all(sql`
      select count(*) as n from body_translations
      where state in ('requested', 'running') and updated_at < ${now - 30 * MIN}
    `),
    db.all(sql`
      select count(*) as n from articles where extract_state = 'due' and fetched_at < ${now - 6 * HOUR}
    `),
  ] as never)) as unknown as unknown[][]
  const problems: string[] = []
  if (count(overdue) > THRESHOLDS.overdueFeeds)
    problems.push(`${count(overdue)} feeds are more than two hours past due`)
  if (count(dead) > THRESHOLDS.deadLettersPerDay)
    problems.push(`${count(dead)} jobs were dead-lettered in the last day`)
  if (count(stuck) > 0)
    problems.push(`${count(stuck)} body translations have been waiting over 30 minutes`)
  if (count(extraction) > THRESHOLDS.extractionBacklog)
    problems.push(`${count(extraction)} articles have waited over six hours for their full text`)
  const backup = await latestBackup(blobs).catch(() => null)
  // No backup yet is a new deployment, not a failure; the first nightly run writes one.
  if (backup && now - backup.finishedAt > THRESHOLDS.backupAgeHours * HOUR)
    problems.push(`the last backup is from ${backup.date}`)
  if (backup && !backup.verified) problems.push(`the ${backup.date} backup failed its check`)
  return { ok: problems.length === 0, problems }
}

/** Tell the dead-man's switch. Its failure is not ours to report: the next ping tries again. */
export async function pingDeadman(
  url: string | undefined,
  h: Health,
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
  const [statuses, failing, deadByKind, deadLatest, llm, posts, members, active, slow] =
    (await db.batch([
      db.all(sql`select status, count(*) as n from feeds group by status order by status`),
      db.all(sql`
        select feed_url as url, status, error_count as errors, last_error as error from feeds
        where error_count > 0 or status = 'dead' order by error_count desc limit 15
      `),
      db.all(
        sql`select kind, count(*) as n from dead_letters where at > ${since} group by kind order by n desc`,
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
  section('Dead letters this week', [
    deadTotal === 0 ? 'none' : (deadByKind ?? []).map((r) => `${r.n} ${r.kind}`).join(', '),
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

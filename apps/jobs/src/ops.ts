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
 * - `digest` is the Monday mail to the owner: what a week of running looked like, and what waits
 *   on them in the admin console.
 * - `checkAlerts` runs beside the health check and mails the owner when something needs them
 *   before Monday: the day's translation budget, a burst of sign-ups, reports waiting (ADR 0063).
 *
 * Each periodic run leaves a heartbeat (`ops_heartbeats`), so the console can say when it last
 * ran and what it saw. The cron handlers in `worker.ts` only call these, so the suite runs them.
 */
import {
  accountsTodaySql,
  backUp,
  DISCOVER_REVIEW,
  type Health,
  health,
  heartbeat,
  latestBackup,
  pruneBackups,
  readSettings,
  type TelaDb,
  utcDay,
} from '@tela/data'
import { type Blobs, type Mail, resendMail } from '@tela/platform'
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

/** Where mail for the operator goes: the digest and the alerts. */
export type Outbox = { mail: Mail; to: string }

/**
 * The operator's outbox from tela-jobs' vars: Resend, to `DIGEST_TO`. Without either there is
 * nowhere to send, and the digest is built but not sent, the alerts not even checked.
 */
export function outboxFrom(vars: {
  DIGEST_TO?: string | undefined
  RESEND_API_KEY?: string | undefined
  MAIL_FROM?: string | undefined
}): Outbox | undefined {
  if (!vars.DIGEST_TO || !vars.RESEND_API_KEY) return undefined
  return {
    mail: resendMail({
      apiKey: vars.RESEND_API_KEY,
      from: vars.MAIL_FROM ?? 'Tela <noreply@telaread.com>',
    }),
    to: vars.DIGEST_TO,
  }
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
  outbox?: Outbox,
  publicUrl?: string,
): Promise<{ sent: boolean; subject: string; text: string }> {
  const mail = await digest(db, blobs, now, publicUrl)
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

/**
 * The Monday mail, as text: what the last week of running looked like. `publicUrl` is Tela's own
 * origin, for the links into the admin console; without it they are paths.
 */
export async function digest(
  db: TelaDb,
  blobs: Blobs,
  now: number,
  publicUrl = '',
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
    review,
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
    // Blogs members added that wait for the operator's review for Discover (ADR 0041).
    db.all(sql`select count(*) as n from sites s where ${DISCOVER_REVIEW}`),
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
  const waiting = count(review)
  section('Discover', [
    waiting === 0
      ? 'no blog members added waits for review'
      : `${waiting} blogs members added wait for review: ${publicUrl.replace(/\/+$/, '')}/admin/discover`,
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

// ---------------------------------------------------------------------------------------------
// Alerts

/** What the alerts did on one run: the markers whose mail went, and those whose send failed. */
export type AlertsReport = { sent: string[]; failed: string[] }

type Alert = {
  /** Its markers in `ops_alerts` for today: a mail goes when one of them is new. */
  markers: string[]
  mail: (fresh: string[]) => { subject: string; text: string }
}

const number = (n: number) => new Intl.NumberFormat('en').format(n)
const plural = (n: number, one: string, other: string) => `${number(n)} ${n === 1 ? one : other}`

/**
 * What needs the operator before Monday's digest (ADR 0063), asked every fifth minute beside the
 * health check, each mailed to the owner once:
 *
 * - `budget:<p>`: the day's model tokens, everyone's together (used and reserved in
 *   `usage_daily`, titles and bodies), have reached p% of `translation.siteDailyTokens`, for each
 *   p in `alerts.budgetPercents`. Once a day each, and thresholds reached together send one mail.
 *   A budget of null (none) or 0 (translation paused on purpose) has no share to warn about.
 * - `signups`: more accounts joined in the UTC day than `alerts.signupsPerDay`. Once a day.
 * - `reports:<hour>`: reports are open, and one came in since the last such mail. At most once an
 *   hour, so a burst of reports is one mail and a queue already seen is not mailed again and again.
 *
 * Each alert is a marker in `ops_alerts`, inserted before its mail: only the run whose insert
 * returned it sends, so two runs never send one alert twice. A send that throws deletes the
 * markers it wrote, and the next run tries again. Without an outbox nothing is checked or marked,
 * so setting `DIGEST_TO` later does not lose the day's alerts. The mails carry counts and links,
 * never a member, an address or what a report says.
 */
export async function checkAlerts(
  db: TelaDb,
  now: number,
  outbox?: Outbox,
  publicUrl = '',
): Promise<AlertsReport> {
  const report: AlertsReport = { sent: [], failed: [] }
  if (!outbox) return report
  const base = publicUrl.replace(/\/+$/, '')
  const day = utcDay(now)
  const settings = await readSettings(db)
  const [spentRows, joinedRows, reportRows] = (await db.batch([
    db.all(sql`select coalesce(sum(used + reserved), 0) as n from usage_daily where day = ${day}`),
    // By profiles, which Tela stamps with its own clock; better-auth stamps `user` with the wall.
    db.all(sql`select ${accountsTodaySql(now)} as n`),
    db.all(sql`
      select count(*) as n, coalesce(sum(created_at > (
        select coalesce(max(at), 0) from ops_alerts where name like 'reports:%'
      )), 0) as fresh
      from reports where state = 'open'
    `),
  ] as never)) as unknown as [{ n: number }[], { n: number }[], { n: number; fresh: number }[]]
  const spent = Number(spentRows[0]?.n ?? 0)
  const joined = Number(joinedRows[0]?.n ?? 0)
  const open = Number(reportRows[0]?.n ?? 0)
  const freshReports = Number(reportRows[0]?.fresh ?? 0)

  const alerts: Alert[] = []
  const budget = settings['translation.siteDailyTokens']
  if (budget !== null && budget > 0) {
    const reached = settings['alerts.budgetPercents'].filter((p) => spent * 100 >= budget * p)
    if (reached.length > 0) {
      alerts.push({
        markers: reached.map((p) => `budget:${p}`),
        mail: (fresh) => {
          const p = Math.max(...fresh.map((name) => Number(name.slice('budget:'.length))))
          const share = Math.floor((spent * 100) / budget)
          return {
            subject:
              p >= 100
                ? "Tela: today's translation budget is spent"
                : `Tela: ${p}% of today's translation budget used`,
            text: [
              `Translation has used ${number(spent)} of today's ${number(budget)} tokens (${share}%), titles and bodies, everyone's together.`,
              '',
              'At the budget, new translations wait for the next UTC day (08:00 in Beijing); those already running finish. It starts again at 00:00 UTC.',
              '',
              `What it was spent on: ${base}/admin/translation`,
              `The budget (translation.siteDailyTokens): ${base}/admin/settings`,
            ].join('\n'),
          }
        },
      })
    }
  }
  const signups = settings['alerts.signupsPerDay']
  if (signups !== null && joined > signups) {
    const cap = settings['signup.maxPerDay']
    alerts.push({
      markers: ['signups'],
      mail: () => ({
        subject: `Tela: ${plural(joined, 'new account', 'new accounts')} today`,
        text: [
          `${plural(joined, 'account has', 'accounts have')} joined Tela today (UTC), more than the ${number(signups)} that sends this mail.`,
          '',
          `If they look like spam, set sign-up to invitations only (signup.mode): ${base}/admin/settings`,
          'It applies from the next person who tries to join; nobody who has joined is affected.',
          ...(cap !== null
            ? [
                `Joining pauses for the rest of the UTC day once ${number(cap)} accounts have joined (signup.maxPerDay).`,
              ]
            : []),
          '',
          `The newest members: ${base}/admin/people`,
        ].join('\n'),
      }),
    })
  }
  if (open > 0 && freshReports > 0) {
    alerts.push({
      markers: [`reports:${new Date(now).toISOString().slice(11, 13)}`],
      mail: () => ({
        subject: `Tela: ${plural(open, 'report waits', 'reports wait')} for a look`,
        text: [
          `${plural(open, 'report is', 'reports are')} open, ${number(freshReports)} of them new since the last mail.`,
          '',
          `Review them in the admin console: ${base}/admin/reports`,
          '',
          'This mail comes at most once an hour, and only when a report has come in since the last one.',
        ].join('\n'),
      }),
    })
  }

  for (const alert of alerts) {
    const inserted = (await db.batch(
      alert.markers.map((name) =>
        db.all(sql`
          insert into ops_alerts (day, name, at) values (${day}, ${name}, ${now})
          on conflict (day, name) do nothing
          returning name
        `),
      ) as never,
    )) as unknown as { name: string }[][]
    const fresh = inserted.flat().map((r) => r.name)
    if (fresh.length === 0) continue
    try {
      await outbox.mail.send({ to: outbox.to, ...alert.mail(fresh) })
      report.sent.push(...fresh)
    } catch (err) {
      // Not sent, so not remembered: the next run finds the marker gone and tries again.
      console.error('alerts: a mail failed', fresh, err)
      await db.batch(
        fresh.map((name) =>
          db.run(sql`delete from ops_alerts where day = ${day} and name = ${name} and at = ${now}`),
        ) as never,
      )
      report.failed.push(...fresh)
    }
  }
  return report
}

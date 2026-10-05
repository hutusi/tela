/**
 * The System ledger (ADR 0039, the design's `ovS`): the health check and the work it watches over
 * the filters, then what ran out of attempts (dead letters), what is backing off after a failure,
 * and what an operator has already resolved. Retrying a dead letter makes its item due again; the
 * next tick does the work.
 */
import type {
  AdminHealth,
  AdminSystemDetail,
  AdminSystemReport,
  AdminSystemRow,
  HealthCheck,
} from '@tela/shared/admin'
import { useCallback, useEffect, useMemo, useRef } from 'react'
import { useLocale, useTranslations } from 'use-intl'
import { Swatch } from '../../components/swatch'
import { useLive } from '../../lib/use-live'
import { adminGet, adminList } from '../api'
import type { AnyAreaSpec, AreaSpec, RecordProps, Status } from '../area'
import { Dot, Evidence, History, KeyValues, Note, StatusPill, useWhen } from '../components/record'
import { useAdmin } from '../context'

/** Each kind of background work, as its tile shows it: a letter, and a colour of its own. */
export const KIND_TILES: Record<string, { letter: string; hue: number }> = {
  'feed.fetch': { letter: 'F', hue: 1 },
  'article.extract': { letter: 'E', hue: 2 },
  'translate.title': { letter: 'T', hue: 3 },
  'translate.body': { letter: 'B', hue: 4 },
  'site.assets': { letter: 'S', hue: 5 },
  'site.claim': { letter: 'C', hue: 6 },
  'websub.subscribe': { letter: 'W', hue: 7 },
  'member.gravatar': { letter: 'G', hue: 8 },
}

/** The kinds in the order tela-jobs lists them (LEASE_KINDS), for the per-kind strip. */
const KINDS = Object.keys(KIND_TILES)

export function KindTile({ kind }: { kind: string }) {
  const tile = KIND_TILES[kind]
  return tile ? (
    <Swatch id={tile.hue} title={tile.letter} />
  ) : (
    <Swatch id={0} title={kind} color="var(--color-muted)" />
  )
}

/**
 * A report the area's header reads when it opens, again on `reload`, and again whenever the
 * console's version moves (after any action or undo), as the list under it does: retrying a dead
 * letter changes the health check, pausing a blog's translation the month's figures. The last
 * report stays up while the next loads. The area's own rows come through the ledger; this is the
 * part above them. A 403 reaches the ledger's own load too, which shows the page that is not there.
 */
export function useReport<T>(path: string) {
  const { version } = useAdmin()
  const load = useCallback((signal?: AbortSignal) => adminGet<T>(path, signal), [path])
  const { value, failed, reload } = useLive(load)
  // The version the area opened at is the one the first load already read.
  const seen = useRef(version)
  useEffect(() => {
    if (version === seen.current) return
    seen.current = version
    void reload()
  }, [version, reload])
  return { value, failed, reload }
}

/** The header's frame while its report loads, or when it did not. */
export function ReportPending({ failed, reload }: { failed: boolean; reload: () => void }) {
  const t = useTranslations('admin.shell')
  return (
    <div className="mt-[22px] flex min-h-24 items-center gap-3 rounded-xl border border-line px-[18px] py-4 text-[13.5px] text-muted">
      {failed ? (
        <>
          <span>{t('ledger.loadFailed')}</span>
          <button
            type="button"
            className="rounded-full border border-thumb px-3 py-1 text-ink-2 hover:border-ink"
            onClick={reload}
          >
            {t('ledger.retry')}
          </button>
        </>
      ) : (
        <span>{t('ledger.loading')}</span>
      )}
    </div>
  )
}

/**
 * A time as the scheduled work is set, in UTC: the hour today, or the day and hour before that.
 * The crons run on UTC (03:17, Mondays 08:00), so the console says when in the same clock.
 */
export function useUtc(): (at: number | null, now?: number) => string | null {
  const locale = useLocale()
  const t = useTranslations('admin.running')
  return (at, now = Date.now()) => {
    if (at === null) return null
    const sameDay =
      new Date(at).toISOString().slice(0, 10) === new Date(now).toISOString().slice(0, 10)
    const time = new Intl.DateTimeFormat(locale, {
      ...(sameDay ? {} : { month: 'short', day: 'numeric' }),
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      timeZone: 'UTC',
    }).format(new Date(at))
    return t('utc', { time })
  }
}

function checkValue(check: HealthCheck, t: ReturnType<typeof useTranslations>): string {
  if (check.name === 'backupVerified') {
    return check.value === null
      ? t('system.none')
      : check.value === 1
        ? t('system.yes')
        : t('system.no')
  }
  if (check.value === null) return t('system.none')
  if (check.name === 'backupAge') return t('system.hours', { n: check.value })
  return String(check.value)
}

/** The health check, a line per question: the Overview can show it as well. */
export function HealthCard({ health }: { health: AdminHealth }) {
  const t = useTranslations('admin.running')
  const utc = useUtc()
  const problems = health.checks.filter((c) => !c.ok).length
  return (
    <section className="flex min-w-0 flex-col rounded-xl border border-line px-[18px] py-4">
      <div className="mb-2 flex flex-wrap items-center gap-2.5">
        <h2 className="m-0 font-serif text-[21px] font-normal">{t('system.health')}</h2>
        <StatusPill
          tone={health.ok ? 'ok' : 'bad'}
          label={health.ok ? t('system.fine') : t('system.problems', { n: problems })}
        />
        <span className="ml-auto text-[12.5px] text-muted">
          {t('system.checked', { time: utc(health.at) ?? '' })}
        </span>
      </div>
      <ul className="m-0 list-none p-0">
        {health.checks.map((check) => (
          <li
            key={check.name}
            className="grid grid-cols-[12px_minmax(0,1fr)_auto] items-center gap-2.5 border-t border-line py-2 text-[13.5px]"
          >
            <Dot tone={check.ok ? 'ok' : 'bad'} />
            <span className={check.ok ? 'text-muted' : 'font-medium text-ink'}>
              {t(`system.checks.${check.name}`)}
            </span>
            <span className="text-ink tabular-nums">
              {checkValue(check, t)}
              {check.limit !== null && check.name !== 'stuckBodies' ? (
                <span className="text-muted">
                  {' / '}
                  {check.name === 'backupAge' ? t('system.hours', { n: check.limit }) : check.limit}
                </span>
              ) : null}
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}

function ScheduledCard({ report }: { report: AdminSystemReport }) {
  const t = useTranslations('admin.running')
  const utc = useUtc()
  const { heartbeats, backup } = report
  const rows: [string, string, string][] = [
    [t('system.tick'), utc(heartbeats.tick) ?? t('system.never'), t('system.tickEvery')],
    [t('system.daily'), utc(heartbeats.daily) ?? t('system.never'), t('system.dailyAt')],
    [
      t('system.export'),
      backup
        ? t('system.exportValue', {
            rows: backup.rows,
            verified: backup.verified ? 'yes' : 'no',
            time: utc(backup.finishedAt) ?? '',
          })
        : t('system.never'),
      t('system.exportKept'),
    ],
    [t('system.digest'), utc(heartbeats.digest) ?? t('system.never'), t('system.digestAt')],
  ]
  return (
    <section className="flex min-w-0 flex-col rounded-xl border border-line px-[18px] py-4">
      <h2 className="m-0 mb-2 font-serif text-[21px] font-normal">{t('system.scheduled')}</h2>
      <dl className="m-0">
        {rows.map(([label, last, when]) => (
          <div
            key={label}
            className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-2.5 gap-y-0.5 border-t border-line py-2 text-[13.5px]"
          >
            <dt className="text-ink">{label}</dt>
            <dd className="m-0 text-right text-muted">{last}</dd>
            <dd className="col-span-2 m-0 text-[12.5px] text-muted">{when}</dd>
          </div>
        ))}
      </dl>
      {heartbeats.health ? (
        <p className="m-0 border-t border-line pt-2 text-[12.5px] text-muted">
          {t(heartbeats.health.ok ? 'system.pingedOk' : 'system.pingedFail', {
            time: utc(heartbeats.health.at) ?? '',
          })}
        </p>
      ) : null}
    </section>
  )
}

function KindStrip({ report }: { report: AdminSystemReport }) {
  const t = useTranslations('admin.running')
  const byKind = new Map(report.kinds.map((k) => [k.kind, k]))
  const kinds = [...KINDS, ...report.kinds.map((k) => k.kind).filter((k) => !KIND_TILES[k])]
  return (
    <section aria-label={t('system.kindsLabel')} className="mt-3.5">
      <ul className="m-0 grid list-none grid-cols-2 gap-px overflow-hidden rounded-xl border border-line bg-line p-0 md:grid-cols-4">
        {kinds.map((kind) => {
          const load = byKind.get(kind)
          return (
            <li key={kind} className="flex min-w-0 flex-col gap-0.5 bg-paper px-4 py-3">
              <span className="truncate font-mono text-[12.5px] text-ink">{kind}</span>
              <span className="text-[12.5px] text-muted">
                {t('system.load', { held: load?.held ?? 0, retrying: load?.retrying ?? 0 })}
              </span>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

/** The health check, the scheduled work, and what each kind holds now. */
export function SystemReportView({ report }: { report: AdminSystemReport }) {
  return (
    <div className="mt-[22px]">
      <div className="grid gap-3.5 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
        <HealthCard health={report.health} />
        <ScheduledCard report={report} />
      </div>
      <KindStrip report={report} />
    </div>
  )
}

/** Over the filters: the report, read when the area opens. */
export function SystemHeader() {
  const { value, failed, reload } = useReport<AdminSystemReport>('system/report')
  if (!value) return <ReportPending failed={failed} reload={() => void reload()} />
  return <SystemReportView report={value} />
}

const Mono = ({ text }: { text: string }) => <span className="font-mono">{text}</span>

function SystemRecord({ row, detail, open }: RecordProps<AdminSystemRow, AdminSystemDetail>) {
  const t = useTranslations('admin.running')
  const when = useWhen()
  const utc = useUtc()
  const current = detail?.row ?? row
  const target = current.target
  const link = target ? (
    <button
      type="button"
      className="self-start text-left text-[13.5px] text-accent hover:underline"
      onClick={() => open(target.area, target.id)}
    >
      {t('system.open', { label: target.label })}
    </button>
  ) : null
  if (current.type === 'lease') {
    return (
      <div className="flex flex-col gap-5">
        <KeyValues
          rows={[
            [t('system.kind'), <Mono key="kind" text={current.kind} />],
            [t('system.key'), <Mono key="key" text={current.key} />],
            [t('system.attempts'), String(current.attempts)],
            [t('system.nextTry'), utc(current.notBefore)],
            [t('system.host'), current.host],
          ]}
        />
        {current.lastError ? (
          <Evidence label={t('system.lastError')} text={current.lastError} />
        ) : null}
        {link}
      </div>
    )
  }
  const resolution =
    current.resolution && current.resolvedAt !== null
      ? `${t(`system.status.${current.resolution}`)} · ${when(current.resolvedAt)}`
      : null
  return (
    <div className="flex flex-col gap-5">
      <KeyValues
        rows={[
          [t('system.kind'), <Mono key="kind" text={current.kind} />],
          [t('system.key'), <Mono key="key" text={current.key} />],
          [t('system.attempts'), String(current.attempts)],
          [t('system.deadSince'), `${utc(current.at)} · ${when(current.at)}`],
          [t('system.resolution'), resolution],
        ]}
      />
      {current.error ? <Evidence label={t('system.lastError')} text={current.error} /> : null}
      {link ?? <Note>{t('system.noTarget')}</Note>}
      {current.kind === 'translate.body' && current.actions.includes('dead.retry') ? (
        <Note>{t('system.bodyRetry')}</Note>
      ) : null}
      <History entries={detail?.history ?? []} />
    </div>
  )
}

export function useSystemArea(): AnyAreaSpec {
  const t = useTranslations('admin.running')
  return useMemo(() => {
    const status = (row: AdminSystemRow): Status => {
      if (row.type === 'lease') return { tone: 'warn', label: t('system.status.retrying') }
      if (row.resolution === 'retried') return { tone: 'ok', label: t('system.status.retried') }
      if (row.resolution === 'dismissed') {
        return { tone: 'neutral', label: t('system.status.dismissed') }
      }
      return { tone: 'bad', label: t('system.status.attempts', { n: row.attempts }) }
    }
    const spec: AreaSpec<'system', AdminSystemRow, AdminSystemDetail> = {
      area: 'system',
      filterLabel: (filter) => t(`filters.system.${filter}`),
      searchHint: t('system.search'),
      load: (filter, q, signal) => adminList<AdminSystemRow, 'system'>('system', filter, q, signal),
      loadDetail: (id, signal) =>
        adminGet<AdminSystemDetail>(`system/${encodeURIComponent(id)}`, signal),
      rowOf: (detail) => detail.row,
      name: {
        label: t('system.name'),
        title: (row) => row.kind,
        sub: (row) => row.target?.label ?? row.key,
        tile: (row) => <KindTile kind={row.kind} />,
      },
      columns: [
        { label: t('system.key'), text: (row) => row.key },
        {
          label: t('system.attempts'),
          text: (row) => String(row.attempts),
          number: (row) => row.attempts,
        },
        {
          label: t('system.error'),
          text: (row) => (row.type === 'lease' ? row.lastError : row.error) ?? '',
        },
      ],
      status,
      Record: SystemRecord,
      Header: SystemHeader,
      bulk: ['dead.retry', 'dead.dismiss'],
      queue: true,
    }
    return spec
  }, [t])
}

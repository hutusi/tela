/**
 * The Translation ledger (ADR 0039, the design's `ovT`): what translation cost over the last 30
 * days, in tokens, by blog, by job and by model. Over the filters, the totals, the day's
 * background budget, the member cap, and the tokens of each day. Dollars and cache hits are not
 * shown: Tela records neither.
 */
import type { AdminTranslationReport, AdminTranslationRow } from '@tela/shared/admin'
import { useMemo } from 'react'
import { useLocale, useTranslations } from 'use-intl'
import { Swatch } from '../../components/swatch'
import { displayHost, pillLabel } from '../../lib/format'
import { nameIn } from '../../lib/language-name'
import { adminList } from '../api'
import type { AnyAreaSpec, AreaSpec, RecordProps, Status } from '../area'
import { KeyValues, Note } from '../components/record'
import { KindTile, ReportPending, TILE, useReport } from './system'

/** Tokens as a stat says them: 24.5M, 2450万. */
function useCompact(): (n: number) => string {
  const locale = useLocale()
  const format = new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 })
  return (n) => format.format(n)
}

function Stat({ label, value, sub }: { label: string; value: string; sub: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 bg-paper px-[18px] py-3.5">
      <span className="text-[12.5px] text-muted">{label}</span>
      <span className="font-serif text-[30px] leading-[1.1] text-ink tabular-nums">{value}</span>
      <span className="text-[12.5px] text-ink-2">{sub}</span>
    </div>
  )
}

/** The background budget's day so far, against what tela-jobs last said the budget is. */
function Background({ report }: { report: AdminTranslationReport }) {
  const t = useTranslations('admin.running')
  const compact = useCompact()
  const { used, reserved, budget } = report.background
  const spent = used + reserved
  const share = budget ? Math.min(1, spent / budget) : 0
  return (
    <div className="flex min-w-0 flex-col gap-1 bg-paper px-[18px] py-3.5">
      <span className="text-[12.5px] text-muted">{t('translation.background')}</span>
      <span className="font-serif text-[30px] leading-[1.1] text-ink tabular-nums">
        {budget
          ? t('translation.backgroundValue', { used: compact(spent), budget: compact(budget) })
          : compact(spent)}
      </span>
      {budget ? (
        // The words above say the figures; the bar only shows them.
        <span aria-hidden="true" className="mt-1 block h-1.5 overflow-hidden rounded-full bg-hover">
          <span
            className={`block h-full rounded-full ${share >= 1 ? 'bg-danger' : 'bg-accent'}`}
            style={{ width: `${share * 100}%` }}
          />
        </span>
      ) : (
        <span className="text-[12.5px] text-ink-2">
          {budget === 0 ? t('translation.unlimited') : t('translation.unknownBudget')}
        </span>
      )}
    </div>
  )
}

/** Thirty bars, one a day, today's in the accent; a sentence says what they show. */
function PerDay({ report }: { report: AdminTranslationReport }) {
  const t = useTranslations('admin.running')
  const locale = useLocale()
  const compact = useCompact()
  const totals = report.days.map((d) => d.title + d.body)
  const peak = Math.max(0, ...totals)
  const peakDay = report.days[totals.indexOf(peak)]?.day ?? ''
  const day = (iso: string) =>
    iso
      ? new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(
          new Date(`${iso}T00:00:00Z`),
        )
      : ''
  const summary = t('translation.chartSummary', {
    total: compact(totals.reduce((a, b) => a + b, 0)),
    peak: compact(peak),
    day: day(peakDay),
    today: compact(totals.at(-1) ?? 0),
  })
  return (
    <section className="mt-3.5 flex flex-col gap-2.5 rounded-xl border border-line px-[18px] py-4">
      <div className="flex justify-between gap-3 text-[12.5px] text-muted">
        <h2 className="m-0 text-[12.5px] font-normal">{t('translation.perDay')}</h2>
        {peak > 0 ? <span>{t('translation.peak', { n: compact(peak) })}</span> : null}
      </div>
      <div role="img" aria-label={summary} className="flex h-24 items-end gap-[3px]">
        {report.days.map((d, i) => {
          const value = d.title + d.body
          const today = i === report.days.length - 1
          return (
            <div
              key={d.day}
              aria-hidden="true"
              title={`${day(d.day)}: ${compact(value)}`}
              className={`min-w-0 flex-1 rounded-t-[2px] ${today ? 'bg-accent' : 'bg-thumb'}`}
              style={{
                height: peak > 0 && value > 0 ? `${Math.max(2, (value / peak) * 100)}%` : 0,
              }}
            />
          )
        })}
      </div>
      <div className="flex justify-between gap-3 text-[12px] text-muted">
        <span>{day(report.days[0]?.day ?? '')}</span>
        <span>{t('translation.today')}</span>
      </div>
    </section>
  )
}

/** The month's tokens and calls, the day's budgets, and the tokens per day. */
export function TranslationReportView({ report }: { report: AdminTranslationReport }) {
  const t = useTranslations('admin.running')
  const compact = useCompact()
  const { inputTokens, outputTokens, calls } = report.totals
  const near = report.nearCap
  return (
    <div className="mt-[22px]">
      <div className="grid grid-cols-1 gap-px overflow-hidden rounded-xl border border-line bg-line sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label={t('translation.tokens')}
          value={compact(inputTokens + outputTokens)}
          sub={t('translation.tokensSub', {
            input: compact(inputTokens),
            output: compact(outputTokens),
          })}
        />
        <Stat
          label={t('translation.calls')}
          value={compact(calls)}
          sub={
            report.unattributed > 0
              ? t('translation.unattributed', { n: compact(report.unattributed) })
              : t('translation.window')
          }
        />
        <Background report={report} />
        <Stat
          label={t('translation.memberCap')}
          value={t('translation.memberCapValue', { cap: compact(report.memberCap) })}
          sub={t('translation.nearCap', { n: near })}
        />
      </div>
      <PerDay report={report} />
    </div>
  )
}

/** Over the filters: the report, read when the area opens. */
export function TranslationHeader() {
  const { value, failed, reload } = useReport<AdminTranslationReport>('translation/report')
  if (!value) return <ReportPending failed={failed} reload={() => void reload()} />
  return <TranslationReportView report={value} />
}

const JOBS = new Set(['translate.title', 'translate.body'])

function TranslationRecord({ row, open }: RecordProps<AdminTranslationRow, null>) {
  const t = useTranslations('admin.running')
  const locale = useLocale()
  const number = new Intl.NumberFormat(locale)
  return (
    <div className="flex flex-col gap-5">
      <KeyValues
        rows={[
          [t('translation.source'), row.sourceLang ? nameIn(row.sourceLang, locale) : null],
          [
            t('translation.into'),
            row.targets.length > 0
              ? row.targets.map((tag) => nameIn(tag, locale)).join(', ')
              : null,
          ],
          [t('translation.callsLabel'), number.format(row.calls)],
          [
            t('translation.tokens'),
            t('translation.tokensSub', {
              input: number.format(row.inputTokens),
              output: number.format(row.outputTokens),
            }),
          ],
          [
            t('translation.latency'),
            row.medianLatencyMs === null
              ? null
              : t('translation.seconds', { s: (row.medianLatencyMs / 1000).toFixed(1) }),
          ],
          [
            t('translation.optOut'),
            row.kind === 'blog'
              ? row.translationOptOut
                ? t('translation.optedOut')
                : t('translation.allowed')
              : null,
          ],
        ]}
      />
      <Note>{t('translation.window')}</Note>
      {row.kind === 'blog' && row.siteId !== null ? (
        <button
          type="button"
          className="self-start text-left text-[13.5px] text-accent hover:underline"
          onClick={() => open('sites', String(row.siteId))}
        >
          {t('translation.openSite')}
        </button>
      ) : null}
    </div>
  )
}

export function useTranslationArea(): AnyAreaSpec {
  const t = useTranslations('admin.running')
  const locale = useLocale()
  return useMemo(() => {
    const compact = new Intl.NumberFormat(locale, {
      notation: 'compact',
      maximumFractionDigits: 1,
    })
    const title = (row: AdminTranslationRow) =>
      row.label ?? (row.homeUrl ? displayHost(row.homeUrl) : row.id)
    const languages = (row: AdminTranslationRow) => {
      const into = row.targets.map(pillLabel).join(', ')
      return row.sourceLang ? `${pillLabel(row.sourceLang)} → ${into}` : into
    }
    const status = (row: AdminTranslationRow): Status => {
      if (row.kind !== 'blog') return { tone: 'neutral', label: t('translation.inUse') }
      return row.translationOptOut
        ? { tone: 'neutral', label: t('translation.optedOutShort') }
        : { tone: 'ok', label: t('translation.translating') }
    }
    const spec: AreaSpec<'translation', AdminTranslationRow, null> = {
      area: 'translation',
      filterLabel: (filter) => t(`filters.translation.${filter}`),
      searchHint: t('translation.search'),
      load: (filter, q, signal) =>
        adminList<AdminTranslationRow, 'translation'>('translation', filter, q, signal),
      loadDetail: null,
      name: {
        label: t('translation.name'),
        title,
        sub: (row) =>
          row.kind === 'blog'
            ? displayHost(row.homeUrl ?? '')
            : row.kind === 'job' && row.label && JOBS.has(row.label)
              ? t(`translation.jobs.${row.label}`)
              : t('translation.model'),
        tile: (row) =>
          row.kind === 'blog' && row.siteId !== null ? (
            <Swatch id={row.siteId} title={title(row)} size={TILE} />
          ) : row.kind === 'job' ? (
            <KindTile kind={row.label ?? ''} />
          ) : (
            <Swatch id={0} title={title(row)} color="var(--color-ink-2)" size={TILE} />
          ),
      },
      columns: [
        { label: t('translation.languages'), text: languages },
        {
          label: t('translation.tokens'),
          text: (row) => compact.format(row.inputTokens + row.outputTokens),
          number: (row) => row.inputTokens + row.outputTokens,
        },
        {
          label: t('translation.callsLabel'),
          text: (row) => compact.format(row.calls),
          number: (row) => row.calls,
        },
      ],
      status,
      Record: TranslationRecord,
      Header: TranslationHeader,
      bulk: ['site.translationOff'],
    }
    return spec
  }, [t, locale])
}

/**
 * The Reports ledger (ADR 0059): each thing members reported, once however many reported it,
 * open until an operator resolves it (acted on) or dismisses it (nothing to do). The record says
 * what the thing is now, links to its public page while there is one, and offers what acts on it
 * from the areas that already do: hide a blog or a blogroll from Discover, cut an app off or end
 * its connections (ADR 0067), suspend or delete its member. Reporters are named in the record and
 * nowhere else.
 */
import type {
  AdminFilter,
  AdminReportDetail,
  AdminReportRow,
  AdminReportTarget,
} from '@tela/shared/admin'
import { useMemo } from 'react'
import { useLocale, useTranslations } from 'use-intl'
import { Swatch } from '../../components/swatch'
import { personColor, relativeTime } from '../../lib/format'
import { actionLook } from '../act'
import { adminGet, adminList } from '../api'
import type { AnyAreaSpec, AreaSpec, RecordProps, Status } from '../area'
import { ActionButton } from '../components/buttons'
import { History, KeyValues, Note, OutLink, Section, useWhen } from '../components/record'
import { type MembersT, PersonLink } from './people'

const loadReports = (filter: AdminFilter<'reports'>, q: string, signal?: AbortSignal) =>
  adminList<AdminReportRow, 'reports'>('reports', filter, q, signal)

const loadReport = (id: string, signal?: AbortSignal) =>
  adminGet<AdminReportDetail>(`reports/${encodeURIComponent(id)}`, signal)

/** What a report names, in words: its name, or what it was once it is gone. */
export function targetTitle(t: MembersT, target: AdminReportTarget): string {
  return target.label ?? t('reports.gone', { kind: t(`reports.kinds.${target.kind}`) })
}

/** The line under it: what kind of thing, and whose. */
export function targetSub(t: MembersT, target: AdminReportTarget): string {
  const kind = t(`reports.kinds.${target.kind}`)
  return target.member ? t('reports.sub', { kind, handle: target.member.handle }) : kind
}

export function reportStatus(t: MembersT, row: AdminReportRow): Status {
  const label = t(`reports.status.${row.state}`)
  if (row.state === 'open') return { tone: 'warn', label }
  return { tone: row.state === 'resolved' ? 'ok' : 'neutral', label }
}

function reportsSpec(
  t: MembersT,
  locale: string,
): AreaSpec<'reports', AdminReportRow, AdminReportDetail> {
  return {
    area: 'reports',
    filterLabel: (filter) => t(`reports.filters.${filter}`),
    searchHint: t('reports.search'),
    load: loadReports,
    loadDetail: loadReport,
    rowOf: (detail) => detail.report,
    name: {
      label: t('reports.name'),
      title: (row) => targetTitle(t, row.target),
      sub: (row) => targetSub(t, row.target),
      tile: (row) => {
        const name = targetTitle(t, row.target)
        return <Swatch id={0} title={name} color={personColor(row.id)} size={28} />
      },
    },
    columns: [
      { label: t('reports.columns.reason'), text: (row) => t(`reports.reasons.${row.reason}`) },
      {
        label: t('reports.columns.reporters'),
        text: (row) => t('reports.reporters', { n: row.reporters }),
        number: (row) => row.reporters,
      },
      {
        label: t('reports.columns.when'),
        text: (row) => relativeTime(row.lastAt, locale),
        number: (row) => row.lastAt,
      },
    ],
    status: (row) => reportStatus(t, row),
    Record: ReportRecord,
    bulk: ['report.resolve', 'report.dismiss'],
    queue: true,
  }
}

export function useReportsArea(): AnyAreaSpec {
  const t = useTranslations('admin.members')
  const locale = useLocale()
  return useMemo(() => reportsSpec(t, locale), [t, locale])
}

function ReportRecord({
  row,
  detail,
  act,
  busy,
  open,
}: RecordProps<AdminReportRow, AdminReportDetail>) {
  const t = useTranslations('admin.members')
  const ts = useTranslations('admin.shell')
  const when = useWhen()
  const report = detail?.report ?? row
  const { target } = report
  const member = target.member
  const decided = report.decidedAt
  const { actions } = target
  // The page opens in a tab of its own: the console stays where it was. An app has none: members
  // meet it on the consent page and in Connected apps, which its record in Apps stands in for.
  const page =
    target.kind === 'app' ? null : target.path ? (
      <OutLink href={target.path}>{target.path}</OutLink>
    ) : (
      t('reports.notPublic')
    )
  const whose = member ? (
    <span className="flex flex-wrap gap-x-2">
      <PersonLink person={member} open={open} />
      {member.standing === 'ok' ? null : (
        <span className="text-muted">{t(`reports.standing.${member.standing}`)}</span>
      )}
    </span>
  ) : null
  return (
    <div className="flex flex-col gap-5">
      <Note>{t('reports.privacy')}</Note>
      <KeyValues
        rows={[
          [t('reports.kv.what'), targetSub(t, target)],
          [t('reports.kv.page'), page],
          [t(target.kind === 'app' ? 'reports.kv.developer' : 'reports.kv.member'), whose],
          [
            t('reports.kv.reasons'),
            report.reasons
              .map((reason) => t(`reports.reasons.${reason}`))
              .join(t('people.separator')),
          ],
          [t('reports.kv.reporters'), t('reports.reporters', { n: report.reporters })],
          [t('reports.kv.first'), when(report.firstAt)],
          [t('reports.kv.last'), when(report.lastAt)],
          [
            t('reports.kv.decided'),
            decided === null
              ? null
              : report.decidedBy
                ? t('reports.decidedBy', { when: when(decided), handle: report.decidedBy.handle })
                : when(decided),
          ],
        ]}
      />
      {target.kind === 'site' && target.siteId !== null ? (
        <button
          type="button"
          onClick={() => open('sites', String(target.siteId))}
          className="cursor-pointer self-start border-0 bg-transparent p-0 text-left text-[13.5px] text-ink underline decoration-thumb underline-offset-2 hover:decoration-ink"
        >
          {t('reports.openBlog')}
        </button>
      ) : null}
      {target.kind === 'app' && target.appId !== null ? (
        <button
          type="button"
          onClick={() => open('apps', String(target.appId))}
          className="cursor-pointer self-start border-0 bg-transparent p-0 text-left text-[13.5px] text-ink underline decoration-thumb underline-offset-2 hover:decoration-ink"
          data-testid="report-open-app"
        >
          {t('reports.openApp')}
        </button>
      ) : null}
      {actions.length > 0 ? (
        <Section label={t('reports.actOn')}>
          <div className="flex flex-wrap gap-2">
            {actions.map(({ action, id }) => (
              <ActionButton
                key={`${action}:${id}`}
                look={actionLook(action, 1)}
                size="sm"
                disabled={busy}
                onClick={() => act(action, [id])}
                data-testid="report-target-action"
                data-action={action}
              >
                {ts(`actions.${action}.label`)}
              </ActionButton>
            ))}
          </div>
        </Section>
      ) : null}
      {detail ? (
        <Section label={t('reports.entries')}>
          <ol className="m-0 flex list-none flex-col gap-3 p-0">
            {detail.reports.map((entry) => (
              <li key={entry.id} className="flex flex-col gap-1 text-[13.5px]">
                <span className="flex flex-wrap gap-x-2 text-ink-2">
                  <span className="font-medium text-ink">
                    {t(`reports.reasons.${entry.reason}`)}
                  </span>
                  <span className="text-muted">
                    {when(entry.at)} · {t(`reports.status.${entry.state}`)}
                  </span>
                  {entry.reporter ? (
                    <PersonLink person={entry.reporter} open={open} />
                  ) : (
                    <span className="text-muted">{t('reports.gonePerson')}</span>
                  )}
                </span>
                {entry.details ? (
                  <p className="m-0 whitespace-pre-line [overflow-wrap:anywhere] text-body">
                    {entry.details}
                  </p>
                ) : null}
                {entry.url ? (
                  <span className="text-[12.5px] [overflow-wrap:anywhere] text-muted">
                    {t('reports.from', { url: entry.url })}
                  </span>
                ) : null}
              </li>
            ))}
          </ol>
        </Section>
      ) : null}
      {detail ? <History entries={detail.history} /> : null}
    </div>
  )
}

/**
 * The Apps ledger (ADRs 0039, 0064, 0067): the apps other developers made, which members connect
 * to their Tela account. A draft connects only for its owner, so its developer can test it; an
 * approved app for any member; a cut-off app for no one, its connections kept for a restore. It
 * opens on the review queue: the apps members registered whose developers asked for a review. The
 * record counts who connected an app and never names them: tela-api never sends who.
 */
import { APP_DEFAULT_PER_APP_PER_MIN, APP_DEFAULT_PER_MEMBER_PER_MIN } from '@tela/shared'
import type {
  AdminAppDetail,
  AdminAppRow,
  AdminAppSettings,
  AdminFilter,
  AdminHistoryEntry,
} from '@tela/shared/admin'
import { useMemo } from 'react'
import { useLocale, useTranslations } from 'use-intl'
import { Swatch } from '../../components/swatch'
import { displayHost, personColor, relativeTime } from '../../lib/format'
import { adminGet, adminSearch } from '../api'
import type { AnyAreaSpec, AreaSpec, RecordProps, Status } from '../area'
import type { AppFormStart } from '../components/app-form'
import { History, KeyValues, Note, OutLink, Section } from '../components/record'
import { fullDate, type MembersT, PersonLink } from './people'

/** A search is posted: an app is found by its developer's address too (`adminSearch`). */
const loadApps = (f: AdminFilter<'apps'>, q: string, signal?: AbortSignal) =>
  adminSearch<AdminAppRow, 'apps'>('apps', f, q, signal)

const loadApp = (id: string, signal?: AbortSignal) =>
  adminGet<AdminAppDetail>(`apps/${encodeURIComponent(id)}`, signal)

/** An app's settings as Edit starts from them: what the row holds, its owner by handle. */
export function settingsOfRow(row: AdminAppRow): AdminAppSettings {
  return {
    name: row.name,
    developer: row.developer,
    contactEmail: row.contactEmail,
    homepageUrl: row.homepageUrl,
    privacyUrl: row.privacyUrl,
    redirectUris: row.redirectUris,
    maxScope: row.maxScope,
    allowEmail: row.allowEmail,
    owner: row.owner?.handle ?? null,
    perMemberPerMin: row.perMemberPerMin,
    perAppPerMin: row.perAppPerMin,
    maxConnections: row.maxConnections,
  }
}

export function appStatus(t: MembersT, row: AdminAppRow): Status {
  switch (row.status) {
    case 'approved':
      return { tone: 'ok', label: t('apps.status.approved') }
    case 'draft':
      return { tone: 'info', label: t('apps.status.draft') }
    default:
      return { tone: 'bad', label: t('apps.status.suspended') }
  }
}

/** A requests-a-minute limit in words: the default named as such, 0 as none. */
export function rateWords(t: MembersT, value: number | null, fallback: number): string {
  return value === null
    ? t('apps.limit.default', { n: fallback })
    : t('apps.limit.perMinute', { n: value })
}

function describeWith(t: MembersT) {
  return (entry: AdminHistoryEntry): string | undefined => {
    switch (entry.action) {
      case 'app.create':
        return t('apps.history.created')
      case 'app.endConnections':
        return t('apps.history.ended', {
          n: (entry.from as { connections?: number } | undefined)?.connections ?? 0,
        })
      default:
        return undefined
    }
  }
}

/** A link out of the console, to the app's own pages, opened apart from it. */
function Out({ href }: { href: string }) {
  return <OutLink href={href}>{displayHost(href)}</OutLink>
}

function AppRecord({ row, detail, open }: RecordProps<AdminAppRow, AdminAppDetail>) {
  const t = useTranslations('admin.members')
  const locale = useLocale()
  const app = detail?.app ?? row
  // Built apart from the rows, as values rather than items of a list React would key.
  const clientId = <span className="font-mono text-[13px] select-all">{app.clientId}</span>
  const homepage = app.homepageUrl ? <Out href={app.homepageUrl} /> : null
  const privacy = app.privacyUrl ? <Out href={app.privacyUrl} /> : null
  const owner = app.owner ? <PersonLink person={app.owner} open={open} /> : t('apps.noOwner')
  const registeredBy = app.registeredBy ? (
    <PersonLink person={app.registeredBy} open={open} />
  ) : (
    t('apps.operator')
  )
  const reviewed =
    app.reviewedAt === null
      ? t('apps.notReviewed')
      : app.reviewedBy
        ? t('apps.reviewedBy', {
            when: fullDate(app.reviewedAt, locale),
            handle: app.reviewedBy.handle,
          })
        : fullDate(app.reviewedAt, locale)
  const asked = app.reviewRequestedAt !== null && app.reviewedAt === null
  return (
    <div className="flex flex-col gap-5">
      <Note>{t(`apps.notes.${app.status}`)}</Note>
      {app.reviewedAt === null ? <Note>{t('apps.notes.unreviewed')}</Note> : null}
      {asked ? (
        <Section label={t('apps.request.label')}>
          <div className="flex flex-col gap-1 text-[13.5px]" data-testid="admin-app-request">
            <span className="text-muted">
              {t('apps.request.when', { when: fullDate(app.reviewRequestedAt ?? 0, locale) })}
            </span>
            <p className="m-0 whitespace-pre-line [overflow-wrap:anywhere] text-body">
              {app.reviewNote ?? t('apps.request.noNote')}
            </p>
            <span className="text-ink-2">
              {app.reviewWantsEmail ? t('apps.request.wantsEmail') : t('apps.request.noEmail')}
            </span>
          </div>
        </Section>
      ) : null}
      <KeyValues
        rows={[
          [t('apps.kv.clientId'), clientId],
          [t('apps.kv.developer'), app.developer],
          [t('apps.kv.registeredBy'), registeredBy],
          [t('apps.kv.terms'), app.termsAt === null ? null : fullDate(app.termsAt, locale)],
          [t('apps.kv.reviewed'), reviewed],
          [t('apps.kv.contact'), app.contactEmail],
          [t('apps.kv.homepage'), homepage],
          [t('apps.kv.privacy'), privacy],
          [t('apps.kv.scope'), t(`apps.scope.${app.maxScope}`)],
          [t('apps.kv.email'), app.allowEmail ? t('apps.email.allowed') : t('apps.email.never')],
          [t('apps.kv.owner'), owner],
          [
            t('apps.kv.perMember'),
            rateWords(t, app.perMemberPerMin, APP_DEFAULT_PER_MEMBER_PER_MIN),
          ],
          [t('apps.kv.perApp'), rateWords(t, app.perAppPerMin, APP_DEFAULT_PER_APP_PER_MIN)],
          [
            t('apps.kv.maxConnections'),
            app.maxConnections === null
              ? t('apps.limit.noCap')
              : t('apps.connected', { n: app.maxConnections }),
          ],
          [t('apps.kv.connections'), t('apps.connected', { n: app.connections })],
          [
            t('apps.kv.lastUsed'),
            app.lastUsedAt === null ? t('apps.never') : relativeTime(app.lastUsedAt, locale),
          ],
          [t('apps.kv.registered'), fullDate(app.createdAt, locale)],
          [
            t('apps.kv.approved'),
            app.approvedAt === null ? null : fullDate(app.approvedAt, locale),
          ],
          [
            t('apps.kv.suspended'),
            app.suspendedAt === null ? null : fullDate(app.suspendedAt, locale),
          ],
        ]}
      />
      <Section label={t('apps.redirects')}>
        <ul className="m-0 flex list-none flex-col gap-1 p-0" data-testid="admin-app-redirects">
          {app.redirectUris.map((uri) => (
            <li key={uri} className="font-mono text-[13px] [overflow-wrap:anywhere] text-ink-2">
              {uri}
            </li>
          ))}
        </ul>
      </Section>
      <Note>{t('apps.notes.private')}</Note>
      {detail ? <History entries={detail.history} describe={describeWith(t)} /> : null}
    </div>
  )
}

export function useAppsArea(): AnyAreaSpec {
  const t = useTranslations('admin.members')
  const locale = useLocale()
  // Built once per language: the ledger may key its loading on the spec's functions.
  return useMemo(() => {
    const spec: AreaSpec<'apps', AdminAppRow, AdminAppDetail> = {
      area: 'apps',
      filterLabel: (filter) => t(`apps.filters.${filter}`),
      searchHint: t('apps.search'),
      load: loadApps,
      loadDetail: loadApp,
      rowOf: (detail) => detail.app,
      name: {
        label: t('apps.name'),
        title: (row) => row.name,
        sub: (row) => row.clientId,
        tile: (row) => <Swatch id={0} title={row.name} color={personColor(row.name)} size={28} />,
      },
      columns: [
        { label: t('apps.columns.developer'), text: (row) => row.developer },
        {
          label: t('apps.columns.connected'),
          text: (row) => t('apps.connected', { n: row.connections }),
          number: (row) => row.connections,
        },
        {
          label: t('apps.columns.lastUsed'),
          text: (row) =>
            row.lastUsedAt === null ? t('apps.never') : relativeTime(row.lastUsedAt, locale),
          number: (row) => row.lastUsedAt,
        },
      ],
      status: (row) => appStatus(t, row),
      Record: AppRecord,
      initial: (row, action) => {
        if (action === 'app.edit') {
          // A member's app stays theirs to test: the form shows its owner, and cannot change it.
          const app: AppFormStart = {
            ...settingsOfRow(row),
            ownerLocked: row.registeredBy !== null,
          }
          return { app }
        }
        // A review starts from what the app may do now, or what its developer asked for.
        // …and names the version read, so an edit made since refuses it.
        if (action === 'app.review') {
          return { allowEmail: row.allowEmail || row.reviewWantsEmail, seen: row.updatedAt }
        }
        return undefined
      },
      bulk: [],
      create: ['app.create'],
    }
    return spec
  }, [t, locale])
}

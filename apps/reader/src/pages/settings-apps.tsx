/**
 * Settings → Connected apps (ADR 0064): the apps a member has connected, what each may do, when it
 * last acted for them, and a way to disconnect it. A live answer, like Account, never the synced
 * tables: a connection is security state, and the apps' own record is on no device. Disconnecting
 * asks first, inline, and stops the app on every device from its next request; what the app
 * already stored stays with it, which the question says. An app Tela has not reviewed says so and
 * is named by its developer's handle, as on the consent page, and every app can be reported
 * (ADR 0067).
 */
import type { Connection } from '@tela/shared'
import { useState } from 'react'
import { Link } from 'react-router'
import { useTranslations } from 'use-intl'
import { ReportLink } from '../components/report-link'
import { disconnect, listConnections } from '../lib/apps-api'
import { useLive } from '../lib/use-live'
import { useUi } from '../ui'

const QUIET =
  'rounded-full border border-thumb px-3.5 py-[7px] text-[13px] font-medium whitespace-nowrap hover:border-ink disabled:opacity-60'
const MUTED_PILL = `${QUIET} text-muted hover:text-ink`
const DANGER_PILL = `${QUIET} text-danger hover:border-danger`

/** A day, year and all, as Settings says when an app was connected and last used. */
export function dayOf(at: number, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  }).format(new Date(at))
}

function Intro({ children }: { children: React.ReactNode }) {
  return <p className="mb-[18px] text-[14px] text-muted md:mb-7">{children}</p>
}

export function AppsSection() {
  const { value, failed, reload } = useLive<Connection[]>(listConnections)
  return <ConnectionList connections={value} failed={failed} onChange={() => void reload()} />
}

/** The section as its answer has it: on its way (null), failed, empty, or a row per app. */
export function ConnectionList({
  connections,
  failed,
  onChange,
}: {
  connections: Connection[] | null
  failed: boolean
  onChange: () => void
}) {
  const t = useTranslations('connectedApps')
  return (
    <>
      <Intro>{t('intro')}</Intro>
      {failed && !connections ? (
        <p role="alert" className="pb-4 text-[13px] text-danger" data-testid="connections-error">
          {t('errors.load')}
        </p>
      ) : null}
      {connections && connections.length === 0 ? (
        <div className="border-t border-line pt-5" data-testid="connections-none">
          <p className="m-0 font-medium text-ink">{t('none')}</p>
          <p className="mt-1.5 mb-0 text-[14px] text-ink-2">{t('noneBody')}</p>
        </div>
      ) : null}
      {connections && connections.length > 0 ? (
        <ul className="m-0 list-none p-0" data-testid="connections">
          {connections.map((connection) => (
            <ConnectionRow key={connection.id} connection={connection} onChange={onChange} />
          ))}
        </ul>
      ) : null}
      {connections ? (
        <p className="border-t border-line pt-4 text-[13px] text-muted">
          {t.rich('more', {
            link: (chunks) => (
              <Link to="/privacy#apps" className="text-ink underline">
                {chunks}
              </Link>
            ),
          })}
        </p>
      ) : null}
    </>
  )
}

export function ConnectionRow({
  connection,
  onChange,
}: {
  connection: Connection
  onChange: () => void
}) {
  const t = useTranslations('connectedApps')
  const { locale } = useUi()
  const [asking, setAsking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const { app } = connection

  const end = async () => {
    setBusy(true)
    setFailed(false)
    try {
      if (await disconnect(connection.id)) {
        setAsking(false)
        onChange()
      } else setFailed(true)
    } catch {
      setFailed(true)
    } finally {
      setBusy(false)
    }
  }

  const used =
    connection.lastUsedAt === null
      ? t('neverUsed')
      : t('lastUsed', { date: dayOf(connection.lastUsedAt, locale) })
  return (
    <li
      className="flex flex-wrap items-start gap-x-4 gap-y-3 border-t border-line py-4"
      data-testid="connection"
      data-id={connection.id}
    >
      <div className="min-w-0 flex-1 basis-60">
        <div
          className="font-medium [overflow-wrap:anywhere] text-ink"
          data-testid="connection-name"
        >
          {app.homepageUrl ? (
            <a
              href={app.homepageUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-ink hover:underline"
            >
              {app.name}
            </a>
          ) : (
            app.name
          )}
        </div>
        <div className="mt-[3px] text-[13px] [overflow-wrap:anywhere] text-muted">
          {!app.reviewed && app.developerHandle
            ? t.rich('byHandle', {
                handle: app.developerHandle,
                member: (chunks) => (
                  <Link to={`/@${app.developerHandle}`} className="text-ink hover:underline">
                    {chunks}
                  </Link>
                ),
              })
            : t('by', { developer: app.developer })}
          {/* A tela-api from before ADR 0067 sends no client id, and a report needs one. */}
          {app.clientId ? (
            <>
              {' · '}
              <ReportLink
                subject={{ kind: 'app', key: app.clientId }}
                path="/settings/apps"
                member
              />
            </>
          ) : null}
        </div>
        {app.reviewed ? null : (
          <div
            className="mt-1.5 flex items-center gap-1.5 text-[13px] text-ink-2"
            data-testid="connection-unreviewed"
          >
            <span aria-hidden="true" className="size-[7px] shrink-0 rounded-full bg-warn" />
            {t('notReviewed')}
          </div>
        )}
        <div className="mt-1.5 text-[13.5px] text-ink-2" data-testid="connection-level">
          {connection.email
            ? t('levelWithEmail', { level: t(`level.${connection.scope}`) })
            : t(`level.${connection.scope}`)}
        </div>
        <div className="mt-[3px] text-[13px] text-muted" data-testid="connection-when">
          {t('when', {
            since: dayOf(connection.createdAt, locale),
            used,
            devices: connection.devices,
          })}
        </div>
        {failed ? (
          <div role="alert" className="mt-1 text-[13px] text-danger">
            {t('errors.failed')}
          </div>
        ) : null}
      </div>
      {asking ? (
        <div
          className="flex basis-full flex-col gap-2.5 rounded-xl border border-line bg-surface p-3.5"
          data-testid="connection-confirm"
        >
          <p className="m-0 text-[13.5px] text-ink-2">{t('confirm', { name: app.name })}</p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => void end()}
              className={DANGER_PILL}
              data-testid="connection-disconnect-yes"
            >
              {t('disconnectYes')}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => setAsking(false)}
              className={MUTED_PILL}
            >
              {t('cancel')}
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setAsking(true)}
          className={MUTED_PILL}
          data-testid="connection-disconnect"
        >
          {t('disconnect')}
        </button>
      )}
    </li>
  )
}

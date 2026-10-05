/**
 * The console's frame (the design's 2a): a 228px sidebar (the mark and an Admin pill, the areas in
 * their groups with what waits in each queue, the member and the way back to reading) and the
 * area the address names, which scrolls on its own. Below `md` the sidebar is a strip that scrolls
 * sideways above the page. The undo toast lives here, at the top of the content column, so it
 * outlasts a move to another area.
 */
import { type AdminArea, type AdminCounts, isLedgerArea } from '@tela/shared/admin'
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { Link, Navigate, useParams } from 'react-router'
import { useTranslations } from 'use-intl'
import { LogoMark } from '../components/logo'
import { PersonAvatar } from '../components/person-avatar'
import { useTitle } from '../lib/title'
import { useLive } from '../lib/use-live'
import { useTables } from '../store/hooks'
import { undoMessage } from './act'
import { adminGet, adminUndo, NotAdmin } from './api'
import { UndoToast } from './components/toast'
import { AdminContext, type AdminContextValue } from './context'
import { isUndoKey, keyLike } from './keys'
import { AreaLedger } from './ledger/ledger'
import { badgeOf, NAV } from './nav'
import { AdminNotFound } from './not-found'
import { Overview } from './overview'
import { NO_TOAST, toastReducer } from './toasts'

const loadCounts = (signal?: AbortSignal) => adminGet<AdminCounts>('counts', signal)

/** `/admin` is the Overview, `/admin/<area>` an area; `area` fixes one regardless of the address. */
export function AdminShell({ area: fixed }: { area?: AdminArea }) {
  const t = useTranslations('admin.shell')
  const params = useParams()
  const named = fixed ?? params.area ?? 'overview'
  const area: AdminArea | null = named === 'overview' || isLedgerArea(named) ? named : null

  const [denied, setDenied] = useState(false)
  const deny = useCallback(() => setDenied(true), [])
  const [version, setVersion] = useState(0)
  const changed = useCallback(() => setVersion((n) => n + 1), [])
  const [toasts, dispatch] = useReducer(toastReducer, NO_TOAST)
  const toast = toasts.toast
  const say = useCallback(
    (text: string, options: { undo?: string | null; error?: boolean } = {}) =>
      dispatch({ type: 'say', text, ...options }),
    [],
  )
  const dismiss = useCallback((id?: number) => dispatch({ type: 'dismiss', id }), [])
  // The toast as of now, for a U pressed before React has drawn the last message.
  const shown = useRef(toast)
  shown.current = toast
  const undoing = useRef<number | null>(null)
  const undo = useCallback(() => {
    const from = shown.current
    const group = from?.undo
    // One undo per toast: a second U while the first is out finds nothing to take back.
    if (!from || !group || undoing.current === from.id) return
    undoing.current = from.id
    dispatch({ type: 'undoing', id: from.id })
    // The answer replaces this toast only: a newer action's toast keeps its words and its Undo.
    adminUndo(group).then(
      (response) => {
        const error = !response || !('restored' in response)
        dispatch({ type: 'reply', to: from.id, text: undoMessage(t, response), error })
        changed()
      },
      (error: unknown) => {
        if (error instanceof NotAdmin) deny()
        else dispatch({ type: 'reply', to: from.id, text: t('errors.failed'), error: true })
      },
    )
  }, [changed, deny, t])
  // U undoes what the toast offers, on the Overview as in any area: one listener, here with the
  // toast, so no page handles it twice. A U the toast has nothing for is left to the browser.
  const undoNow = useRef(undo)
  undoNow.current = undo
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isUndoKey(keyLike(e)) || !shown.current?.undo) return
      e.preventDefault()
      undoNow.current()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const admin = useMemo<AdminContextValue>(
    () => ({ version, changed, toast, say, dismiss, undo, deny }),
    [version, changed, toast, say, dismiss, undo, deny],
  )

  const counts = useLive(loadCounts)
  const reloadCounts = counts.reload
  useEffect(() => {
    if (version > 0) void reloadCounts()
  }, [version, reloadCounts])
  useEffect(() => {
    if (counts.error instanceof NotAdmin) deny()
  }, [counts.error, deny])

  useTitle(area ? `${t(`nav.${area}`)} · ${t('title')}` : null)

  // The Overview has one address.
  if (params.area === 'overview' && !fixed) return <Navigate to="/admin" replace />
  if (denied || area === null) return <AdminNotFound />
  return (
    <AdminContext.Provider value={admin}>
      <div
        className="flex min-h-dvh flex-col bg-paper text-ink md:grid md:h-dvh md:min-h-0 md:grid-cols-[228px_minmax(0,1fr)] md:grid-rows-[minmax(0,1fr)]"
        data-testid="admin-shell"
      >
        <Sidebar area={area} counts={counts.value} />
        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
          <main className="min-h-0 flex-1 px-4 pt-5 md:overflow-y-auto md:px-6 md:pt-[30px] xl:px-9">
            {area === 'overview' ? <Overview /> : <AreaLedger key={area} area={area} />}
          </main>
          <UndoToast />
        </div>
      </div>
    </AdminContext.Provider>
  )
}

function Sidebar({ area, counts }: { area: AdminArea; counts: AdminCounts | null }) {
  const t = useTranslations('admin.shell')
  const profile = useTables().profile
  return (
    <aside
      className="admin-side sticky top-0 z-20 flex shrink-0 items-center gap-4 overflow-x-auto border-b [scrollbar-width:none] md:[scrollbar-width:thin] border-line px-4 py-2.5 md:static md:min-h-0 md:flex-col md:items-stretch md:gap-5 md:overflow-x-visible md:overflow-y-auto md:border-r md:border-b-0 md:px-3 md:pt-[18px] md:pb-4"
      data-testid="admin-nav"
    >
      <Link
        to="/admin"
        className="flex shrink-0 items-center gap-[9px] text-ink hover:no-underline md:px-2 md:pt-0.5"
      >
        <LogoMark size={24} />
        <span className="font-serif text-[23px] leading-none font-semibold tracking-[-0.01em]">
          Tela
        </span>
        <span className="rounded-full border border-thumb px-2 py-0.5 text-[10.5px] font-semibold tracking-[.08em] text-muted uppercase">
          {t('badge')}
        </span>
      </Link>
      <nav
        aria-label={t('navLabel')}
        className="flex shrink-0 items-center gap-1 md:min-h-0 md:flex-col md:items-stretch md:gap-4"
      >
        {NAV.map(({ group, areas }) => (
          <div
            key={group ?? 'top'}
            className="flex shrink-0 items-center gap-1 md:flex-col md:items-stretch md:gap-px"
          >
            {group ? (
              <div className="hidden px-2.5 pb-1.5 text-[11px] font-semibold tracking-[.08em] text-muted uppercase md:block">
                {t(`groups.${group}`)}
              </div>
            ) : null}
            {areas.map((item) => {
              const on = item === area
              const n = badgeOf(item, counts)
              return (
                <Link
                  key={item}
                  to={item === 'overview' ? '/admin' : `/admin/${item}`}
                  aria-current={on ? 'page' : undefined}
                  className={`flex shrink-0 items-center gap-2.5 rounded-lg px-2.5 py-[7px] font-medium whitespace-nowrap hover:bg-hover hover:text-ink hover:no-underline ${on ? 'bg-hover text-ink' : 'text-ink-2'}`}
                  data-testid="admin-nav-item"
                  data-area={item}
                >
                  <span className="md:flex-1">{t(`nav.${item}`)}</span>
                  {n > 0 ? (
                    <span
                      className="min-w-5 rounded-full bg-accent px-1.5 py-px text-center text-[11.5px] font-semibold text-paper tabular-nums"
                      data-testid="admin-badge"
                    >
                      {n}
                    </span>
                  ) : null}
                </Link>
              )
            })}
          </div>
        ))}
      </nav>
      <div className="hidden flex-1 md:block" />
      <div className="hidden flex-col gap-3 border-t border-line px-2 pt-3.5 md:flex">
        {profile ? (
          <div className="flex min-w-0 items-center gap-2.5">
            <PersonAvatar
              handle={profile.handle}
              displayName={profile.displayName}
              avatar={profile.avatar}
              size={30}
              me
            />
            <div className="flex min-w-0 flex-col leading-[1.3]">
              <span className="truncate font-medium">{profile.displayName ?? profile.handle}</span>
              <span className="text-[12px] text-muted">{t('role')}</span>
            </div>
          </div>
        ) : null}
        <Link to="/reading" className="text-[13px] text-ink-2 hover:text-ink hover:no-underline">
          {t('back')}
        </Link>
      </div>
      <Link
        to="/reading"
        className="shrink-0 text-[13px] whitespace-nowrap text-ink-2 hover:text-ink hover:no-underline md:hidden"
      >
        {t('back')}
      </Link>
    </aside>
  )
}

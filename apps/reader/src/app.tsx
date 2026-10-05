/** The reader app: providers, and one route per page. Every page renders from the local store. */
import { isUiLocale, type UiLocale } from '@tela/shared'
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router'
import { AppHeader } from './components/app-header'
import { FrontDoorProvider, ToReading } from './components/front-door'
import { detectLocale, I18n, localeCookie } from './i18n'
import { applyTheme, deviceTheme, PREFS, themeToAdopt, typographyOf } from './lib/typography'
import { forgetPublic } from './lib/use-public'
import { AddPage } from './pages/add'
import { ClaimPage, ClaimSitePage } from './pages/claim'
import { DashboardPage } from './pages/dashboard'
import { DiscoverPage } from './pages/discover'
import { FollowingPage } from './pages/following'
import { InfoPage } from './pages/info'
import { JoinPage } from './pages/join'
import { LandingPage } from './pages/landing'
import { LoginPage } from './pages/login'
import { NotFoundPage } from './pages/not-found'
import { ProfilePage, profilePath } from './pages/profile'
import { ReadingPage } from './pages/reading'
import { SearchPage } from './pages/search'
import { SettingsPage } from './pages/settings'
import { SitePage } from './pages/site'
import { WritersPage } from './pages/writers'
import { SessionProvider, useSession } from './session'
import type { SyncEngine } from './store/engine'
import { StoreProvider, useStore, useTables } from './store/hooks'
import type { LocalStore } from './store/local'
import type { Objects } from './store/objects'
import { UiContext } from './ui'

/** The admin console (ADR 0039): its own chunk, fetched only when an admin opens it. */
const AdminApp = lazy(() => import('./admin'))

/** A page only members see: anyone else signs in first and comes back. */
function Members({ children }: { children: React.ReactNode }) {
  const { status } = useSession()
  const location = useLocation()
  if (status === 'unknown') return null
  if (status === 'guest') {
    const next = encodeURIComponent(location.pathname + location.search)
    return <Navigate to={`/login?next=${next}`} replace />
  }
  return <>{children}</>
}

/**
 * `/`: a member's reading, and the front page for anyone else (ADR 0035). A device that holds no
 * account shows the front page while /me is still out, so the edge's copy is not replaced by a
 * blank page; a member signing in on a new device sees it for that one round trip.
 */
function Home() {
  const { status } = useSession()
  const { store } = useStore()
  if (status === 'member')
    return (
      <ToReading>
        <LandingPage />
      </ToReading>
    )
  if (status === 'guest' || store.userId === null) return <LandingPage />
  return null
}

/** `/@handle` shares a segment with every other top-level path, so it is told apart here. */
function HandleOrMissing() {
  const location = useLocation()
  return location.pathname.startsWith('/@') ? <ProfilePage /> : <NotFoundPage />
}

function Routed() {
  const { store } = useStore()
  // A follow the server now has, or an unfollow: the profile page held for this visit, and the one
  // the browser cached, still count the old state. Forgotten here, wherever the member is, so a
  // return to that profile fetches it again past the cache (ADR 0031).
  useEffect(() => {
    store.onFollowsConfirmed = (rows) => {
      for (const row of rows) if (row.handle) forgetPublic(profilePath(row.handle))
    }
    return () => {
      store.onFollowsConfirmed = null
    }
  }, [store])
  // The member's own profile changed (a privacy switch, a new name or handle), and the server has
  // it: the copies of their public profile held this visit, and the one the browser cached, still
  // say what it said. Watched here, not on the profile page, which is not mounted while Settings
  // makes the change. A new handle forgets both addresses.
  const tables = useTables()
  const ownSeq = tables.profile?.seq ?? null
  const ownHandle = tables.profile?.handle ?? null
  const lastOwn = useRef({ seq: ownSeq, handle: ownHandle })
  useEffect(() => {
    const last = lastOwn.current
    lastOwn.current = { seq: ownSeq, handle: ownHandle }
    if (last.seq === null || ownSeq === null || last.seq === ownSeq) return
    if (last.handle) forgetPublic(profilePath(last.handle))
    if (ownHandle && ownHandle !== last.handle) forgetPublic(profilePath(ownHandle))
  }, [ownSeq, ownHandle])
  const [locale, setLocaleState] = useState<UiLocale>(() =>
    detectLocale(document.cookie, navigator.languages ?? [navigator.language]),
  )
  const applyLocale = useCallback((next: UiLocale) => {
    // biome-ignore lint/suspicious/noDocumentCookie: the edge reads it to render public pages.
    document.cookie = localeCookie(next)
    setLocaleState(next)
  }, [])
  // A member's choice is a mutation even before their first sync has brought the profile: it
  // waits with the others, and lands on the row when that arrives. Skipping it then left only the
  // cookie, and the row's older choice, applied below, took the page back. A visitor has no owner,
  // and `mutate` keeps nothing for no one.
  const setLocale = useCallback(
    (next: UiLocale) => {
      applyLocale(next)
      store.mutate({ type: 'setProfile', uiLocale: next })
    },
    [store, applyLocale],
  )
  // A member's interface language is their profile's, so a choice made on another device or in
  // another tab arrives here with the sync, and the cookie follows it for the edge. Applied when
  // the profile's value changes, never when the page's does: a row that has not caught up with a
  // click would otherwise undo it. Nothing is sent back; this device only learns the choice.
  const accountLocale = tables.profile?.uiLocale ?? null
  const lastAccountLocale = useRef<string | null>(null)
  useEffect(() => {
    const last = lastAccountLocale.current
    lastAccountLocale.current = accountLocale
    if (accountLocale !== last && isUiLocale(accountLocale)) applyLocale(accountLocale)
  }, [accountLocale, applyLocale])
  useEffect(() => {
    document.documentElement.lang = locale
  }, [locale])
  // A member's theme is a synced pref; a visitor keeps whatever this browser last had. An account
  // that has never chosen one takes the visitor's, once: the first snapshot brings every pref
  // with the profile, so no row then means none. Written as the pref, never only put on the page,
  // or the page would be dark while Settings said Auto. A browser shared by two accounts gives
  // the second whatever it shows, which is what that member is looking at anyway.
  const theme = typographyOf(tables).theme
  const synced = tables.profile !== null
  const chosen = tables.prefs.has(PREFS.theme)
  const adoptedFor = useRef<string | null>(null)
  useEffect(() => {
    if (!synced) return
    const owner = store.userId
    if (!chosen && owner !== null && adoptedFor.current !== owner) {
      adoptedFor.current = owner
      // Read now, not from the render: the store and the device are as they are when this runs.
      const adopt = themeToAdopt(store.getSnapshot().tables, deviceTheme())
      if (adopt) {
        // The page shows it already; the pref's own render puts it on again.
        store.mutate({ type: 'setPref', key: PREFS.theme, value: adopt })
        return
      }
    }
    applyTheme(theme)
  }, [synced, chosen, theme, store])
  const ui = useMemo(() => ({ locale, setLocale }), [locale, setLocale])
  return (
    <UiContext.Provider value={ui}>
      <I18n locale={locale}>
        <FrontDoorProvider>
          <div className="flex min-h-full flex-col">
            <Routes>
              <Route path="/login" element={<LoginPage />} />
              <Route
                path="/admin/*"
                element={
                  <Members>
                    <Suspense fallback={null}>
                      <AdminApp />
                    </Suspense>
                  </Members>
                }
              />
              <Route
                path="*"
                element={
                  <>
                    <AppHeader />
                    <Routes>
                      <Route path="/" element={<Home />} />
                      <Route path="/join" element={<JoinPage />} />
                      <Route
                        path="/reading"
                        element={
                          <Members>
                            <ReadingPage />
                          </Members>
                        }
                      />
                      <Route path="/discover" element={<DiscoverPage />} />
                      <Route path="/writers" element={<WritersPage />} />
                      <Route
                        path="/following"
                        element={
                          <Members>
                            <FollowingPage />
                          </Members>
                        }
                      />
                      <Route path="/s/:siteId" element={<SitePage />} />
                      <Route path="/about" element={<InfoPage page="about" />} />
                      <Route path="/privacy" element={<InfoPage page="privacy" />} />
                      <Route path="/terms" element={<InfoPage page="terms" />} />
                      <Route
                        path="/search"
                        element={
                          <Members>
                            <SearchPage />
                          </Members>
                        }
                      />
                      <Route
                        path="/add"
                        element={
                          <Members>
                            <AddPage />
                          </Members>
                        }
                      />
                      <Route
                        path="/settings"
                        element={
                          <Members>
                            <SettingsPage />
                          </Members>
                        }
                      />
                      <Route
                        path="/settings/:section"
                        element={
                          <Members>
                            <SettingsPage />
                          </Members>
                        }
                      />
                      <Route
                        path="/dashboard"
                        element={
                          <Members>
                            <DashboardPage />
                          </Members>
                        }
                      />
                      <Route
                        path="/claim"
                        element={
                          <Members>
                            <ClaimPage />
                          </Members>
                        }
                      />
                      <Route
                        path="/sites/:siteId/claim"
                        element={
                          <Members>
                            <ClaimSitePage />
                          </Members>
                        }
                      />
                      <Route path="*" element={<HandleOrMissing />} />
                    </Routes>
                  </>
                }
              />
            </Routes>
          </div>
        </FrontDoorProvider>
      </I18n>
    </UiContext.Provider>
  )
}

export function App(props: { store: LocalStore; engine: SyncEngine; objects: Objects }) {
  const handle = useMemo(() => props, [props])
  return (
    <StoreProvider value={handle}>
      <SessionProvider store={props.store} engine={props.engine}>
        <BrowserRouter>
          <Routed />
        </BrowserRouter>
      </SessionProvider>
    </StoreProvider>
  )
}

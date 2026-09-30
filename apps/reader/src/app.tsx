/** The reader app: providers, and one route per page. Every page renders from the local store. */
import type { UiLocale } from '@tela/shared'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router'
import { AppHeader } from './components/app-header'
import { detectLocale, I18n, localeCookie } from './i18n'
import { applyTheme, typographyOf } from './lib/typography'
import { AddPage } from './pages/add'
import { ClaimPage, ClaimSitePage } from './pages/claim'
import { DashboardPage } from './pages/dashboard'
import { DiscoverPage } from './pages/discover'
import { FollowingPage } from './pages/following'
import { LandingPage } from './pages/landing'
import { LoginPage } from './pages/login'
import { NotFoundPage } from './pages/not-found'
import { ProfilePage } from './pages/profile'
import { ReadingPage } from './pages/reading'
import { SearchPage } from './pages/search'
import { SettingsPage } from './pages/settings'
import { SitePage } from './pages/site'
import { SessionProvider, useSession } from './session'
import type { SyncEngine } from './store/engine'
import { StoreProvider, useStore, useTables } from './store/hooks'
import type { LocalStore } from './store/local'
import type { Objects } from './store/objects'
import { UiContext } from './ui'

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

function Home() {
  const { status } = useSession()
  if (status === 'unknown') return null
  return status === 'member' ? <Navigate to="/reading" replace /> : <LandingPage />
}

/** `/@handle` shares a segment with every other top-level path, so it is told apart here. */
function HandleOrMissing() {
  const location = useLocation()
  return location.pathname.startsWith('/@') ? <ProfilePage /> : <NotFoundPage />
}

function Routed() {
  const { store } = useStore()
  const [locale, setLocaleState] = useState<UiLocale>(() =>
    detectLocale(document.cookie, navigator.languages ?? [navigator.language]),
  )
  const setLocale = useCallback(
    (next: UiLocale) => {
      // biome-ignore lint/suspicious/noDocumentCookie: the edge reads it to render public pages.
      document.cookie = localeCookie(next)
      setLocaleState(next)
      if (store.hasData) store.mutate({ type: 'setProfile', uiLocale: next })
    },
    [store],
  )
  useEffect(() => {
    document.documentElement.lang = locale
  }, [locale])
  // A member's theme is a synced pref; a visitor keeps whatever this browser last had.
  const tables = useTables()
  const theme = typographyOf(tables).theme
  const synced = tables.profile !== null
  useEffect(() => {
    if (synced) applyTheme(theme)
  }, [synced, theme])
  const ui = useMemo(() => ({ locale, setLocale }), [locale, setLocale])
  return (
    <UiContext.Provider value={ui}>
      <I18n locale={locale}>
        <div className="flex min-h-full flex-col">
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route
              path="*"
              element={
                <>
                  <AppHeader />
                  <Routes>
                    <Route path="/" element={<Home />} />
                    <Route
                      path="/reading"
                      element={
                        <Members>
                          <ReadingPage />
                        </Members>
                      }
                    />
                    <Route path="/discover" element={<DiscoverPage />} />
                    <Route
                      path="/following"
                      element={
                        <Members>
                          <FollowingPage />
                        </Members>
                      }
                    />
                    <Route path="/s/:siteId" element={<SitePage />} />
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

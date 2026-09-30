/**
 * Public pages, rendered at the edge (ADR 0025): Discover, a blog's page and a member's profile,
 * for visitors who have no shell cached yet and for link previews. The same views the SPA renders,
 * with a guest session and an empty store; the page's data is handed over in `#tela-data`, so the
 * SPA's first render needs no request of its own.
 */
import type { UiLocale } from '@tela/shared'
import { renderToString } from 'react-dom/server'
import { StaticRouter } from 'react-router'
import { createTranslator } from 'use-intl'
import { AppHeader } from './components/app-header'
import { I18n, MESSAGES } from './i18n'
import { type DiscoverParams, discoverApiPath, parseDiscoverParams } from './lib/discover-href'
import { displayHost } from './lib/format'
import { pageTitle } from './lib/title'
import { NotFoundPage } from './pages/not-found'
import { handleFrom, profilePath } from './pages/profile'
import { sitePath } from './pages/site'
import { GuestSession } from './session'
import { memoryPersistence } from './store/db'
import { SyncEngine } from './store/engine'
import { StoreProvider } from './store/hooks'
import { LocalStore } from './store/local'
import { Objects } from './store/objects'
import { UiContext } from './ui'
import { DiscoverView } from './views/discover'
import { ProfileView, profileTab } from './views/profile'
import { SiteView } from './views/site'
import type { DiscoverData, ProfileData, SiteData } from './views/types'

/**
 * `key` is what the edge caches the page under when it is not `api` alone: a profile's tabs share
 * one endpoint and are different pages.
 */
export type PublicRoute =
  | { kind: 'discover'; params: DiscoverParams; api: string }
  | { kind: 'site'; siteId: number; api: string }
  | { kind: 'profile'; handle: string; tab: string | null; api: string; key: string }

/** The public page a URL names, and the endpoint its data comes from; null for anything else. */
export function publicRoute(url: URL): PublicRoute | null {
  if (url.pathname === '/discover') {
    const params = parseDiscoverParams(url.searchParams)
    return { kind: 'discover', params, api: discoverApiPath(params) }
  }
  const site = url.pathname.match(/^\/s\/(\d{1,12})$/)
  if (site) return { kind: 'site', siteId: Number(site[1]), api: sitePath(Number(site[1])) }
  const handle = handleFrom(url.pathname)
  if (handle) {
    const asked = url.searchParams.get('tab')
    const tab = asked === 'liked' || asked === 'subscriptions' ? asked : null
    const api = profilePath(handle)
    return { kind: 'profile', handle, tab, api, key: tab ? `${api}?tab=${tab}` : api }
  }
  return null
}

/** Nothing a page says may close the script it is handed over in. */
const inScript = (value: unknown) => JSON.stringify(value).replace(/</g, '\\u003c')

const escapeHtml = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => `&${{ '&': 'amp', '<': 'lt', '>': 'gt', '"': 'quot', "'": '#39' }[c]};`,
  )

function titleOf(
  route: PublicRoute,
  data: unknown,
  locale: UiLocale,
): { title: string; description: string | null } {
  const t = createTranslator({ locale, messages: MESSAGES[locale] })
  if (data === null) return { title: t('notFound.title'), description: null }
  if (route.kind === 'discover')
    return { title: t('nav.discover'), description: t('discover.intro') }
  if (route.kind === 'site') {
    const { site } = data as SiteData
    return { title: site.title ?? displayHost(site.homeUrl), description: site.description }
  }
  const { profile } = data as ProfileData
  return { title: profile.displayName ?? `@${profile.handle}`, description: profile.bio }
}

/**
 * The page as HTML, poured into the SPA's own index.html. `data` null means the endpoint said the
 * page does not exist (a private blog, an unknown handle).
 */
export function renderPublicPage(input: {
  route: PublicRoute
  url: URL
  data: unknown
  locale: UiLocale
  now: number
  template: string
}): string {
  const { route, url, data, locale, now, template } = input
  const store = new LocalStore(memoryPersistence())
  const handle = {
    store,
    engine: new SyncEngine(store, { onSignedOut() {}, onUpgrade() {}, onAccountChanged() {} }),
    objects: new Objects(memoryPersistence()),
  }
  const view =
    data === null ? (
      <NotFoundPage />
    ) : route.kind === 'discover' ? (
      <DiscoverView data={data as DiscoverData} params={route.params} locale={locale} />
    ) : route.kind === 'site' ? (
      <SiteView
        data={data as SiteData}
        reading={{ lang: locale, never: [] }}
        locale={locale}
        now={now}
      />
    ) : (
      <ProfileView
        data={data as ProfileData}
        tab={profileTab(route.tab, data as ProfileData)}
        reading={{ lang: locale, never: [] }}
        locale={locale}
        now={now}
      />
    )
  const body = renderToString(
    <StoreProvider value={handle}>
      <GuestSession>
        <StaticRouter location={url.pathname + url.search}>
          <UiContext.Provider value={{ locale, setLocale() {} }}>
            <I18n locale={locale}>
              <div className="flex min-h-full flex-col">
                <AppHeader />
                {view}
              </div>
            </I18n>
          </UiContext.Provider>
        </StaticRouter>
      </GuestSession>
    </StoreProvider>,
  )
  const { title, description } = titleOf(route, data, locale)
  const meta = [
    `<title>${escapeHtml(pageTitle(title))}</title>`,
    `<meta property="og:title" content="${escapeHtml(title)}" />`,
    ...(description
      ? [
          `<meta name="description" content="${escapeHtml(description)}" />`,
          `<meta property="og:description" content="${escapeHtml(description)}" />`,
        ]
      : []),
  ].join('\n    ')
  const handover =
    data === null
      ? ''
      : `<script id="tela-data" type="application/json">${inScript({ path: route.api, body: data })}</script>`
  return (
    template
      // The page's own description replaces the site's, before the page's is put in.
      .replace(/\s*<meta name="description"[^>]*>/, description ? '' : '$&')
      // The shell's noindex is for the app; whether a public page is indexed is the edge's header.
      .replace(/\s*<meta name="robots"[^>]*>/, '')
      // Functions, not strings: a `$&` in a blog's title is text, not a replacement pattern.
      .replace(/<html lang="[^"]*"/, () => `<html lang="${locale}"`)
      .replace(/<title>[^<]*<\/title>/, () => meta)
      .replace('<div id="root"></div>', () => `<div id="root">${body}</div>${handover}`)
  )
}

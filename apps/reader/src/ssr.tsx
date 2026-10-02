/**
 * Public pages, rendered at the edge (ADR 0025, 0035): the front page, Discover, a blog's page, a
 * member's profile, and About, Privacy and Terms, for visitors who have no shell cached yet and for
 * link previews. The same views the SPA renders, with a guest session and an empty store; the
 * page's data is handed over in `#tela-data`, so the SPA's first render needs no request of its
 * own. About, Privacy and Terms take no data at all (ADR 0035): their copy is in the bundle.
 */
import type { UiLocale } from '@tela/shared'
import { renderToString } from 'react-dom/server'
import { StaticRouter } from 'react-router'
import { createTranslator } from 'use-intl'
import { AppHeader } from './components/app-header'
import { type InfoPageId, isInfoPage } from './content/info/types'
import { I18n, MESSAGES } from './i18n'
import { type DiscoverParams, discoverApiPath, parseDiscoverParams } from './lib/discover-href'
import { FRONT_PATH, frontHref, type TitlesMode, titlesMode } from './lib/edition'
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
import { InfoView, infoDescription } from './views/info'
import { LandingView } from './views/landing'
import { ProfileView, profileTab } from './views/profile'
import { profileDataOf, siteDataOf } from './views/public-data'
import { SiteView } from './views/site'
import type { DiscoverData, FrontData, ProfileData, SiteData } from './views/types'

/**
 * `key` is what the edge caches the page under when it is not `api` alone: a profile's tabs share
 * one endpoint and are different pages, and so are the front page's two title modes. `api` null:
 * the page needs nothing from tela-api.
 * `visitorsOnly`: a member is sent the plain shell, whose app takes them on (the front page sends
 * them to their reading). `alwaysExists`: no answer from tela-api makes it a 404 page; one that
 * is not the page's data is the plain shell, which asks again from the browser.
 */
export type PublicRoute =
  | {
      kind: 'landing'
      titles: TitlesMode
      api: string
      key: string
      visitorsOnly: true
      alwaysExists: true
    }
  | { kind: 'discover'; params: DiscoverParams; api: string }
  | { kind: 'site'; siteId: number; api: string }
  | { kind: 'profile'; handle: string; tab: string | null; api: string; key: string }
  | { kind: 'info'; page: InfoPageId; api: null; key: string }

/** The public page a URL names, and the endpoint its data comes from; null for anything else. */
export function publicRoute(url: URL): PublicRoute | null {
  if (url.pathname === '/') {
    const titles = titlesMode(url.searchParams)
    return {
      kind: 'landing',
      titles,
      api: FRONT_PATH,
      key: frontHref(titles),
      visitorsOnly: true,
      alwaysExists: true,
    }
  }
  if (url.pathname === '/discover') {
    const params = parseDiscoverParams(url.searchParams)
    return { kind: 'discover', params, api: discoverApiPath(params) }
  }
  const info = url.pathname.slice(1)
  if (isInfoPage(info)) return { kind: 'info', page: info, api: null, key: `/info/${info}` }
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
): { title: string | null; description: string | null } {
  const t = createTranslator({ locale, messages: MESSAGES[locale] })
  // The front page is Tela's own: titled by its name alone, whatever its data said.
  if (route.kind === 'landing') return { title: null, description: t('front.description') }
  if (route.kind === 'info')
    return { title: t(`info.tabs.${route.page}`), description: infoDescription(locale, route.page) }
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
    route.kind === 'landing' ? (
      <LandingView
        data={data as FrontData | null}
        loading={false}
        titles={route.titles}
        reading={locale}
        locale={locale}
        now={now}
      />
    ) : route.kind === 'info' ? (
      <InfoView page={route.page} locale={locale} year={new Date(now).getFullYear()} />
    ) : data === null ? (
      <NotFoundPage />
    ) : route.kind === 'discover' ? (
      <DiscoverView data={data as DiscoverData} params={route.params} locale={locale} />
    ) : route.kind === 'site' ? (
      <SiteView
        data={siteDataOf(data as SiteData)}
        reading={{ lang: locale, never: [] }}
        locale={locale}
        now={now}
      />
    ) : (
      <ProfileView
        data={profileDataOf(data as ProfileData)}
        tab={profileTab(route.tab, profileDataOf(data as ProfileData))}
        reading={{ lang: locale, never: [] }}
        locale={locale}
        now={now}
      />
    )
  // The front page renders from its key, not the address asked: it is cached for every visitor,
  // and a campaign's query string or anything else in the address is not the page's to keep.
  const location = route.kind === 'landing' ? route.key : url.pathname + url.search
  const body = renderToString(
    <StoreProvider value={handle}>
      <GuestSession>
        <StaticRouter location={location}>
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
    `<meta property="og:title" content="${escapeHtml(title ?? 'Tela')}" />`,
    ...(description
      ? [
          `<meta name="description" content="${escapeHtml(description)}" />`,
          `<meta property="og:description" content="${escapeHtml(description)}" />`,
        ]
      : []),
  ].join('\n    ')
  // A page without data (About, Privacy, Terms) hands nothing over.
  const handover =
    data === null || route.api === null
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

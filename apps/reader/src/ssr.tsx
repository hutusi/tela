/**
 * Public pages, rendered at the edge (ADR 0025, 0035): the front page, Discover's tabs (ADR 0044;
 * Blogrolls, ADR 0050), a blog's page, a member's profile, a public blogroll (ADR 0050), About,
 * Privacy and Terms, For writers (ADR 0061) and How Tela reads your blog (ADR 0070), for visitors
 * who have no shell cached yet and for link previews. The same views the SPA renders, with a guest
 * session and an empty store; the page's data is handed over in `#tela-data`, so the SPA's first
 * render needs no request of its own. About, Privacy, Terms, For writers and How Tela reads your
 * blog take no data at all (ADR 0035): their copy is in the bundle. Each page's head says where it is in every language (`?hl=`), how it previews, whether
 * it is indexed, and what it is in schema.org's terms (ADR 0060, `lib/head.ts`).
 */
import { hlLocale, UI_LOCALES, type UiLocale } from '@tela/shared'
import { renderToString } from 'react-dom/server'
import { StaticRouter } from 'react-router'
import { createTranslator } from 'use-intl'
import { AppHeader } from './components/app-header'
import { type InfoPageId, isInfoPage } from './content/info/types'
import { I18n, MESSAGES } from './i18n'
import {
  blogrollPath,
  blogrollsApiPath,
  blogrollsCursor,
  blogrollsHref,
  isBlogrollId,
} from './lib/blogroll-href'
import {
  type ArticlesParams,
  articlesApiPath,
  articlesHref,
  type BlogsParams,
  blogsApiPath,
  blogsHref,
  legacyDiscover,
  parseArticlesParams,
  parseBlogsParams,
  READERS_PATH,
  tabHref,
  WEEK_PATH,
} from './lib/discover-href'
import { NOTHING_HIDDEN } from './lib/discover-overlay'
import { type ComposedWeek, composeWeek } from './lib/discover-week'
import { FRONT_PATH, frontHref, type TitlesMode, titlesMode } from './lib/edition'
import { blogrollFeedHref, discoverFeedHref } from './lib/feed-href'
import { blogAddress } from './lib/format'
import { headTags, inScript, type PageHead } from './lib/head'
import { suggestReaders } from './lib/suggest-readers'
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
import { BlogrollView } from './views/blogroll'
import { BotView } from './views/bot'
import { DiscoverView } from './views/discover'
import { articlesList, DiscoverArticlesView } from './views/discover-articles'
import { DiscoverBlogrollsView } from './views/discover-blogrolls'
import { DiscoverReadersView } from './views/discover-readers'
import { DiscoverWeekView, WEEK_READERS } from './views/discover-week'
import { InfoView, infoDescription } from './views/info'
import { LandingView } from './views/landing'
import { ProfileView, profileTab } from './views/profile'
import { blogrollDataOf, profileDataOf, siteDataOf } from './views/public-data'
import { SiteView } from './views/site'
import type {
  ArticlesData,
  BlogrollData,
  BlogrollsData,
  DiscoverData,
  DiscoverPost,
  FrontData,
  ProfileData,
  PublicArticle,
  ReadersData,
  SiteData,
  WeekData,
} from './views/types'
import { WritersView } from './views/writers'

/**
 * `key` is what the edge caches the page under when it is not `api` alone: a profile's tabs share
 * one endpoint and are different pages, and so are the front page's two title modes. `api` null:
 * the page needs nothing from tela-api.
 * `visitorsOnly`: a member is sent the plain shell, whose app takes them on (the front page sends
 * them to their reading). `alwaysExists`: no answer from tela-api makes it a 404 page; one that
 * is not the page's data is the plain shell, which asks again from the browser. Discover's tabs
 * always exist, so a tela-web deployed before the tela-api that answers them never caches a Not
 * found at `/discover`. `redirect`: an address from before the tabs, answered without tela-api.
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
  | { kind: 'week'; api: string; alwaysExists: true }
  | { kind: 'articles'; params: ArticlesParams; api: string; key: string; alwaysExists: true }
  | { kind: 'blogs'; params: BlogsParams; api: string; alwaysExists: true }
  | { kind: 'blogrolls'; cursor: string | null; api: string; key: string; alwaysExists: true }
  | { kind: 'readers'; api: string; alwaysExists: true }
  | { kind: 'redirect'; api: null; redirect: string }
  | { kind: 'site'; siteId: number; api: string }
  | { kind: 'profile'; handle: string; tab: string | null; api: string; key: string }
  | { kind: 'blogroll'; id: string; api: string }
  | { kind: 'info'; page: InfoPageId; api: null; key: string }
  | { kind: 'writers'; api: null; key: string }
  | { kind: 'bot'; api: null; key: string }

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
    const legacy = legacyDiscover(url.pathname, url.search)
    if (legacy) return { kind: 'redirect', api: null, redirect: legacy }
    return { kind: 'week', api: WEEK_PATH, alwaysExists: true }
  }
  if (url.pathname === '/discover/articles') {
    const params = parseArticlesParams(url.searchParams)
    // One endpoint for both sorts, and two pages: cached apart, as a cursor's page is.
    const key = articlesHref(params)
    return { kind: 'articles', params, api: articlesApiPath(params), key, alwaysExists: true }
  }
  if (url.pathname === '/discover/blogs') {
    const params = parseBlogsParams(url.searchParams)
    return { kind: 'blogs', params, api: blogsApiPath(params), alwaysExists: true }
  }
  if (url.pathname === '/discover/blogrolls') {
    // Only a cursor tela-api could have written; anything else is the first page.
    const cursor = blogrollsCursor(url.searchParams)
    const api = blogrollsApiPath(cursor)
    return { kind: 'blogrolls', cursor, api, key: blogrollsHref(cursor), alwaysExists: true }
  }
  if (url.pathname === '/discover/readers') {
    return { kind: 'readers', api: READERS_PATH, alwaysExists: true }
  }
  // For writers, as a visitor sees it: its copy is in the bundle, and the count of blogs the app
  // fetches once it takes the page over (ADR 0061).
  if (url.pathname === '/writers') return { kind: 'writers', api: null, key: '/writers' }
  // How Tela reads your blog (ADR 0070): copy only, like For writers.
  if (url.pathname === '/bot') return { kind: 'bot', api: null, key: '/bot' }
  const info = url.pathname.slice(1)
  if (isInfoPage(info)) return { kind: 'info', page: info, api: null, key: `/info/${info}` }
  const site = url.pathname.match(/^\/s\/(\d{1,12})$/)
  if (site) return { kind: 'site', siteId: Number(site[1]), api: sitePath(Number(site[1])) }
  // A blogroll's page by its id, and nothing else under `/l/`. A private one is a 404 here, and
  // the SPA that boots on that page shows its owner their own (ADR 0050).
  const blogroll = url.pathname.match(/^\/l\/([^/]*)$/)?.[1]
  if (isBlogrollId(blogroll)) return { kind: 'blogroll', id: blogroll, api: blogrollPath(blogroll) }
  const handle = handleFrom(url.pathname)
  if (handle) {
    const asked = url.searchParams.get('tab')
    const tab =
      asked === 'blogrolls' || asked === 'liked' || asked === 'subscriptions' ? asked : null
    const api = profilePath(handle)
    return { kind: 'profile', handle, tab, api, key: tab ? `${api}?tab=${tab}` : api }
  }
  return null
}

/**
 * The address a page renders as, and is canonical at (ADR 0060). A page cached under a key renders
 * from what the key says, not the address asked: it is cached for every visitor, and a campaign's
 * query string, a `?hl=` or anything else in the address is not the page's to keep.
 */
function pageAddress(route: PublicRoute): string {
  switch (route.kind) {
    case 'landing':
    case 'articles':
    case 'blogrolls':
      return route.key
    case 'week':
      return tabHref('week')
    case 'readers':
      return tabHref('readers')
    case 'blogs':
      return blogsHref(route.params)
    case 'site':
      return `/s/${route.siteId}`
    case 'blogroll':
      return `/l/${route.id}`
    case 'profile':
      return `/@${route.handle}${route.tab ? `?tab=${route.tab}` : ''}`
    case 'info':
      return `/${route.page}`
    case 'writers':
      return '/writers'
    case 'bot':
      return '/bot'
    case 'redirect':
      return route.redirect
  }
}

/** Entries a list's structured data names: enough to say what the list is, not the whole page. */
const LIST_ITEMS = 25
/** Posts a blog's structured data names, of those its page shows. */
const BLOG_POSTS = 10
/** Neither indexed nor followed: what anyone can publish, before anyone has vouched for it. */
const UNVOUCHED = 'noindex, nofollow'

const iso = (ms: number | null | undefined) =>
  typeof ms === 'number' && Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : undefined

/** A post's title as a visitor's page shows it: in their language when it has one there. */
const titleIn = (article: PublicArticle, locale: UiLocale) =>
  article.titles?.[locale] ?? article.title

/** A list as schema.org's ItemList: how many entries have an address, and the first of them. */
function itemList(items: { url: string | null; name: string }[]): Record<string, unknown> {
  const listed = items.filter((i): i is { url: string; name: string } => Boolean(i.url))
  return {
    '@type': 'ItemList',
    numberOfItems: listed.length,
    itemListElement: listed.slice(0, LIST_ITEMS).map((item, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      url: item.url,
      name: item.name,
    })),
  }
}

/** Discover's posts as list entries: each at the original post's address, never Tela's. */
const postItems = (posts: readonly DiscoverPost[], locale: UiLocale) =>
  posts.map((p) => ({ url: p.article.url, name: titleIn(p.article, locale) }))

/**
 * What a page says about itself in its head: title, description, address, robots rule and
 * structured data (ADR 0060). What anyone can publish is indexed only once someone has vouched
 * for it: a blog an operator listed, a profile a week old, a blogroll Discover shows. tela-api
 * says which (`indexable`), and an answer that does not say is not indexed.
 */
function headOf(
  route: PublicRoute,
  data: unknown,
  locale: UiLocale,
  origin: string,
  week: ComposedWeek | null,
): PageHead {
  const t = createTranslator({ locale, messages: MESSAGES[locale] })
  const path = pageAddress(route)
  const collection = (title: string, list: Record<string, unknown>) => ({
    '@type': 'CollectionPage',
    name: title,
    description: t('discover.intro'),
    url: `${origin}${path}`,
    inLanguage: locale,
    mainEntity: list,
  })
  // The front page is Tela's own: titled by its name alone, whatever its data said.
  if (route.kind === 'landing') {
    return {
      title: null,
      description: t('front.description'),
      path,
      robots: null,
      jsonLd: {
        '@type': 'WebSite',
        name: 'Tela',
        url: `${origin}/`,
        description: t('front.description'),
        inLanguage: [...UI_LOCALES],
      },
    }
  }
  if (route.kind === 'info') {
    return {
      title: t(`info.tabs.${route.page}`),
      description: infoDescription(locale, route.page),
      path,
      robots: null,
    }
  }
  // For writers, as a visitor reads it (ADR 0061): indexed like an info page.
  if (route.kind === 'writers') {
    return {
      title: t('writers.title'),
      description: t('writers.description'),
      path,
      robots: null,
    }
  }
  if (route.kind === 'bot') {
    return {
      title: t('writers.reading.title'),
      description: t('writers.reading.description'),
      path,
      robots: null,
    }
  }
  if (data === null || route.kind === 'redirect') {
    return { title: t('notFound.title'), description: null, path: null, robots: 'noindex' }
  }
  if (route.kind === 'week') {
    const title = t('nav.discover')
    const posts = week ? [...(week.lead ? [week.lead] : []), ...week.rest] : []
    return {
      title,
      description: t('discover.intro'),
      path,
      robots: null,
      jsonLd: collection(title, itemList(postItems(posts, locale))),
    }
  }
  if (
    route.kind === 'articles' ||
    route.kind === 'blogs' ||
    route.kind === 'blogrolls' ||
    route.kind === 'readers'
  ) {
    const title = `${t(`discover.tabs.${route.kind}`)} · ${t('nav.discover')}`
    const items =
      route.kind === 'articles'
        ? postItems(articlesList([data as ArticlesData], route.params.sort, NOTHING_HIDDEN), locale)
        : route.kind === 'blogs'
          ? (data as DiscoverData).sites.map((s) => ({
              url: `${origin}/s/${s.id}`,
              name: s.title ?? blogAddress(s.homeUrl),
            }))
          : route.kind === 'blogrolls'
            ? ((data as BlogrollsData).blogrolls ?? []).map((b) => ({
                url: `${origin}/l/${b.id}`,
                name: b.name,
              }))
            : suggestReaders((data as ReadersData).readers, null).map(({ person }) => ({
                url: `${origin}/@${person.handle}`,
                name: person.displayName ?? `@${person.handle}`,
              }))
    // A page past the first is a moment's slice of a list that moves on: followed, not indexed.
    // Articles and Blogrolls page by a cursor, Blogs by its number.
    const cursor =
      (route.kind === 'articles' && route.params.cursor !== null) ||
      (route.kind === 'blogrolls' && route.cursor !== null) ||
      (route.kind === 'blogs' && route.params.page > 1)
    return {
      title,
      description: t('discover.intro'),
      path,
      robots: cursor ? 'noindex' : null,
      jsonLd: collection(title, itemList(items)),
    }
  }
  if (route.kind === 'site') {
    const { site, posts } = siteDataOf(data as SiteData)
    const name = site.title ?? blogAddress(site.homeUrl)
    const published = posts.filter((a) => a.url).slice(0, BLOG_POSTS)
    return {
      title: name,
      description: site.description,
      path,
      robots: site.indexable === true ? null : UNVOUCHED,
      jsonLd: {
        '@type': 'Blog',
        name,
        // The blog is where it is published; this page is Tela's, about it.
        url: site.homeUrl,
        ...(site.description ? { description: site.description } : {}),
        ...(site.primaryLang ? { inLanguage: site.primaryLang } : {}),
        ...(site.claimant
          ? {
              author: {
                '@type': 'Person',
                name: site.claimant.displayName ?? `@${site.claimant.handle}`,
                url: `${origin}/@${site.claimant.handle}`,
              },
            }
          : {}),
        // Each post as its writer published it: its own title, in the language it names.
        blogPost: published.map((a) => ({
          '@type': 'BlogPosting',
          headline: a.title,
          url: a.url,
          ...(iso(a.publishedAt) ? { datePublished: iso(a.publishedAt) } : {}),
          ...(a.sourceLang ? { inLanguage: a.sourceLang } : {}),
        })),
      },
    }
  }
  if (route.kind === 'blogroll') {
    const { blogroll, owner, blogs } = blogrollDataOf(data as BlogrollData)
    const by = owner.displayName ?? `@${owner.handle}`
    const description = blogroll.description || t('discover.blogrolls.by', { name: by })
    return {
      title: blogroll.name,
      description,
      path,
      robots: blogroll.indexable === true ? null : UNVOUCHED,
      jsonLd: {
        '@type': 'CollectionPage',
        name: blogroll.name,
        description,
        url: `${origin}${path}`,
        author: { '@type': 'Person', name: by, url: `${origin}/@${owner.handle}` },
        mainEntity: itemList(
          blogs.map((b) => ({
            url: b.listed ? `${origin}/s/${b.siteId}` : b.homeUrl,
            name: b.name ?? blogAddress(b.homeUrl),
          })),
        ),
      },
    }
  }
  const { profile } = profileDataOf(data as ProfileData)
  const name = profile.displayName ?? `@${profile.handle}`
  const avatar = profile.avatar ? new URL(profile.avatar, origin).toString() : null
  return {
    title: name,
    description: profile.bio,
    path,
    robots: profile.indexable === true ? null : UNVOUCHED,
    type: 'profile',
    username: profile.handle,
    jsonLd: {
      '@type': 'ProfilePage',
      url: `${origin}${path}`,
      ...(iso(profile.memberSince) ? { dateCreated: iso(profile.memberSince) } : {}),
      mainEntity: {
        '@type': 'Person',
        name,
        alternateName: `@${profile.handle}`,
        url: `${origin}/@${profile.handle}`,
        ...(profile.bio ? { description: profile.bio } : {}),
        ...(avatar ? { image: avatar } : {}),
      },
    },
  }
}

/**
 * The feeds a page offers (ADR 0062), as `<link rel="alternate">` for a feed reader handed the
 * page's address (`feeds` in its head, ADR 0060): a blogroll's own, while it has a listed blog for
 * them to hold, and Discover's on every tab, narrowed to its topic. The RSS reads in the page's
 * language, as the page does.
 */
function feedsOf(
  route: PublicRoute,
  data: unknown,
  locale: UiLocale,
): NonNullable<PageHead['feeds']> {
  if (data === null) return []
  const feed = (type: string, title: string, href: string) => ({ type, title, href })
  if (route.kind === 'blogroll') {
    const { blogroll, blogs } = data as BlogrollData
    if (!blogs?.some((b) => b.listed)) return []
    return [
      feed(
        'application/rss+xml',
        `${blogroll.name} · RSS`,
        blogrollFeedHref(route.id, 'rss', locale),
      ),
      feed('text/x-opml', `${blogroll.name} · OPML`, blogrollFeedHref(route.id, 'opml')),
    ]
  }
  if (
    route.kind !== 'week' &&
    route.kind !== 'articles' &&
    route.kind !== 'blogs' &&
    route.kind !== 'blogrolls' &&
    route.kind !== 'readers'
  ) {
    return []
  }
  const topic = route.kind === 'articles' || route.kind === 'blogs' ? route.params.topic : null
  const name = `${createTranslator({ locale, messages: MESSAGES[locale] })('nav.discover')} · Tela`
  return [
    feed('application/rss+xml', `${name} · RSS`, discoverFeedHref('rss', { topic, hl: locale })),
    feed('text/x-opml', `${name} · OPML`, discoverFeedHref('opml', { topic, hl: locale })),
  ]
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
  // The edge's reader reads in the page's language and translates everything else.
  const reading = { lang: locale, never: [] }
  // For a visitor: nothing hidden. Composed once, for the page and for what its head lists.
  const week =
    route.kind === 'week' && data !== null ? composeWeek(data as WeekData, NOTHING_HIDDEN) : null
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
    ) : route.kind === 'writers' ? (
      <WritersView visitor ownHandle={null} blogs={null} locale={locale} now={now} />
    ) : route.kind === 'bot' ? (
      <BotView year={new Date(now).getFullYear()} />
    ) : data === null || route.kind === 'redirect' ? (
      <NotFoundPage />
    ) : route.kind === 'week' ? (
      // For a visitor: nothing hidden, and only the readers anyone may be suggested.
      <DiscoverWeekView
        week={week ?? composeWeek(data as WeekData, NOTHING_HIDDEN)}
        readers={suggestReaders((data as WeekData).readers, null).slice(0, WEEK_READERS)}
        reading={reading}
        locale={locale}
        now={now}
      />
    ) : route.kind === 'articles' ? (
      <DiscoverArticlesView
        posts={articlesList([data as ArticlesData], route.params.sort, NOTHING_HIDDEN)}
        languages={(data as ArticlesData).languages}
        next={(data as ArticlesData).next}
        params={route.params}
        reading={reading}
        locale={locale}
        now={now}
      />
    ) : route.kind === 'blogs' ? (
      <DiscoverView data={data as DiscoverData} params={route.params} locale={locale} />
    ) : route.kind === 'blogrolls' ? (
      // For a visitor: no reasons, and the cards as tela-api sent them.
      <DiscoverBlogrollsView
        cards={(data as BlogrollsData).blogrolls ?? []}
        next={(data as BlogrollsData).next ?? null}
        hl={locale}
      />
    ) : route.kind === 'readers' ? (
      <DiscoverReadersView
        suggestions={suggestReaders((data as ReadersData).readers, null)}
        reading={reading}
      />
    ) : route.kind === 'site' ? (
      <SiteView data={siteDataOf(data as SiteData)} reading={reading} locale={locale} now={now} />
    ) : route.kind === 'blogroll' ? (
      <BlogrollView
        data={blogrollDataOf(data as BlogrollData)}
        locale={locale}
        now={now}
        feeds={{ hl: locale }}
      />
    ) : (
      <ProfileView
        data={profileDataOf(data as ProfileData)}
        tab={profileTab(route.tab, profileDataOf(data as ProfileData))}
        reading={reading}
        locale={locale}
        now={now}
      />
    )
  const location = pageAddress(route)
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
  const head = {
    ...headOf(route, data, locale, url.origin, week),
    feeds: feedsOf(route, data, locale),
  }
  // The address fixes the language, and the page is in it (ADR 0060): a member's page is not,
  // unless the language named is their own.
  const pinned = hlLocale(url.searchParams.get('hl')) === locale
  const meta = headTags(head, { origin: url.origin, locale, pinned }).join('\n    ')
  // A page without data (About, Privacy, Terms, For writers, /bot) hands nothing over.
  const handover =
    data === null || route.api === null
      ? ''
      : `<script id="tela-data" type="application/json">${inScript({ path: route.api, body: data })}</script>`
  return (
    template
      // The page's own description replaces the site's, before the page's is put in.
      .replace(/\s*<meta name="description"[^>]*>/, head.description ? '' : '$&')
      // The shell's noindex is for the app. A public page says its own rule, which the edge
      // repeats as X-Robots-Tag, and TELA_NOINDEX is the edge's alone.
      .replace(/\s*<meta name="robots"[^>]*>/, '')
      // Functions, not strings: a `$&` in a blog's title is text, not a replacement pattern.
      .replace(/<html lang="[^"]*"/, () => `<html lang="${locale}"`)
      .replace(/<title>[^<]*<\/title>/, () => meta)
      .replace('<div id="root"></div>', () => `<div id="root">${body}</div>${handover}`)
  )
}

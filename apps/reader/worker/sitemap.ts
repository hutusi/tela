/**
 * Sitemaps (ADR 0060), written at the edge. `/sitemap.xml` is an index naming one file of Tela's
 * own pages (`/sitemap-pages.xml`: the front page, Discover's tabs and topics, About, Privacy,
 * Terms, For writers) and a file per kind of page tela-api lists (blogs, blogrolls, profiles),
 * paged with `?page=` once a kind outgrows one file. Every file sits at the site's root, since a
 * sitemap may only list addresses under its own directory, and each is named in
 * `run_worker_first` on its own: never a wildcard.
 *
 * Each page is five `<url>`s, its four `?hl=` addresses and the bare one, and each of the five
 * names all five as `xhtml:link` alternates, as Google asks of a page in several languages.
 */
import { BLOGROLL_ID, HANDLE, TOPICS, UI_LOCALES } from '@tela/shared'
import { INFO_PAGES, INFO_UPDATED } from '../src/content/info/types'
import { blogsHref, DISCOVER_TABS, tabHref } from '../src/lib/discover-href'
import { withHl } from '../src/lib/head'

/** What tela-api lists for the sitemap (`apps/api/src/routes/sitemap.ts`). */
export const SITEMAP_KINDS = ['sites', 'blogrolls', 'profiles'] as const
export type SitemapKind = (typeof SITEMAP_KINDS)[number]
export type SitemapSummary = { pageSize: number } & Record<
  SitemapKind,
  { count: number; lastmod: number | null }
>
export type SitemapItems = {
  items: { id?: number | string; handle?: string; lastmod: number | null }[]
}

export const SITEMAP_INDEX = '/sitemap.xml'
export const PAGES_SITEMAP = '/sitemap-pages.xml'
export const sitemapPath = (kind: SitemapKind) => `/sitemap-${kind}.xml`
/** Every path a sitemap is served at: each in `run_worker_first`, by name. */
export const SITEMAP_PATHS = [SITEMAP_INDEX, PAGES_SITEMAP, ...SITEMAP_KINDS.map(sitemapPath)]

/** The kind a sitemap file's path lists, `pages` for Tela's own, or null for no sitemap. */
export function sitemapOf(path: string): SitemapKind | 'index' | 'pages' | null {
  if (path === SITEMAP_INDEX) return 'index'
  if (path === PAGES_SITEMAP) return 'pages'
  return SITEMAP_KINDS.find((kind) => sitemapPath(kind) === path) ?? null
}

/** The `?page=` of a kind's file: from 1, and nothing tela-api would not answer. */
export function sitemapPage(value: string | null): number | null {
  if (value === null) return 1
  const page = Number(value)
  return Number.isInteger(page) && page >= 1 && page <= 1000 && String(page) === value ? page : null
}

const xml = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => `&${{ '&': 'amp', '<': 'lt', '>': 'gt', '"': 'quot', "'": 'apos' }[c]};`,
  )

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10)

/** A page as a sitemap lists it: its address without `?hl=`, and when it last changed. */
export type SitemapPage = { path: string; lastmod: number | null }

/** One page's five entries, each naming all five addresses. */
function entries(origin: string, page: SitemapPage): string {
  const at = (locale: (typeof UI_LOCALES)[number] | null) => `${origin}${withHl(page.path, locale)}`
  const links = [
    ...UI_LOCALES.map(
      (locale) => `<xhtml:link rel="alternate" hreflang="${locale}" href="${xml(at(locale))}"/>`,
    ),
    `<xhtml:link rel="alternate" hreflang="x-default" href="${xml(at(null))}"/>`,
  ].join('')
  const lastmod = page.lastmod ? `<lastmod>${day(page.lastmod)}</lastmod>` : ''
  return [null, ...UI_LOCALES]
    .map((locale) => `<url><loc>${xml(at(locale))}</loc>${lastmod}${links}</url>`)
    .join('\n')
}

export function urlset(origin: string, pages: readonly SitemapPage[]): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">',
    ...pages.map((page) => entries(origin, page)),
    '</urlset>',
    '',
  ].join('\n')
}

export function sitemapIndex(origin: string, summary: SitemapSummary): string {
  const files: { path: string; lastmod: number | null }[] = [{ path: PAGES_SITEMAP, lastmod: null }]
  for (const kind of SITEMAP_KINDS) {
    const { count, lastmod } = summary[kind]
    const pages = Math.ceil(count / Math.max(1, summary.pageSize))
    for (let page = 1; page <= pages; page++) {
      files.push({ path: `${sitemapPath(kind)}${page > 1 ? `?page=${page}` : ''}`, lastmod })
    }
  }
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...files.map(
      (file) =>
        `<sitemap><loc>${xml(`${origin}${file.path}`)}</loc>${file.lastmod ? `<lastmod>${day(file.lastmod)}</lastmod>` : ''}</sitemap>`,
    ),
    '</sitemapindex>',
    '',
  ].join('\n')
}

/**
 * Tela's own pages: the front page, Discover's tabs and each topic of its Blogs, the info pages
 * (dated as their copy is), For writers and How Tela reads your blog.
 */
export function ownPages(): SitemapPage[] {
  const updated = Date.parse(`${INFO_UPDATED}T00:00:00Z`)
  return [
    { path: '/', lastmod: null },
    ...DISCOVER_TABS.map((tab) => ({ path: tabHref(tab), lastmod: null })),
    ...TOPICS.map((topic) => ({ path: blogsHref({ topic }), lastmod: null })),
    ...INFO_PAGES.map((page) => ({ path: `/${page}`, lastmod: updated })),
    { path: '/writers', lastmod: null },
    { path: '/bot', lastmod: null },
  ]
}

/** A kind's file of pages, from tela-api's items: each only at an address its page has. */
export function kindPages(kind: SitemapKind, data: SitemapItems): SitemapPage[] {
  return data.items.flatMap(({ id, handle, lastmod }) => {
    const at = (path: string) => [{ path, lastmod: typeof lastmod === 'number' ? lastmod : null }]
    if (kind === 'sites') return Number.isSafeInteger(id) && Number(id) > 0 ? at(`/s/${id}`) : []
    if (kind === 'blogrolls')
      return typeof id === 'string' && BLOGROLL_ID.test(id) ? at(`/l/${id}`) : []
    return typeof handle === 'string' && HANDLE.test(handle) ? at(`/@${handle}`) : []
  })
}

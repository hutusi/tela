/**
 * The `<head>` of a page the edge renders (ADR 0060): its title and description, the canonical
 * address and one alternate per interface language, Open Graph and Twitter's card, the page's
 * robots rule, its feeds, and its structured data. Plain strings, for `renderPublicPage` to pour
 * into the shell; no React.
 *
 * A page is at one address per language: `?hl=<locale>` fixes the language, and the address
 * without it (`x-default`) is in whichever the visitor's cookie or browser asks for. A pinned page
 * is canonical at its own `?hl=` address, an unpinned one at the bare address; both name the same
 * five alternates, so every language's copy points at every other.
 */
import { UI_LOCALES, type UiLocale } from '@tela/shared'
import { pageTitle } from './title'

/** Open Graph names a locale as language_TERRITORY, and has no script subtag. */
export const OG_LOCALES: Record<UiLocale, string> = {
  en: 'en_US',
  fr: 'fr_FR',
  'zh-Hans': 'zh_CN',
  'zh-Hant': 'zh_TW',
}

/** The share card, one per interface language (`scripts/generate-share-cards.ts`). */
export const SHARE_CARD = { width: 1200, height: 630 } as const
export const shareCardPath = (locale: UiLocale) => `/og/${locale}.png`

/** What a page says about itself; everything else in the head follows from where it is. */
export type PageHead = {
  /** The page's own title; null is Tela's name alone. */
  title: string | null
  description: string | null
  /**
   * The address the page is canonical at, path and query, without `?hl=`; null for a page with
   * no address of its own to give (a 404).
   */
  path: string | null
  /**
   * `null`: indexed. Otherwise the robots rule, as `<meta name="robots">` and X-Robots-Tag say,
   * and a page with `noindex` names no canonical and no languages.
   */
  robots: string | null
  /** Open Graph's type: a member's profile is a `profile`. */
  type?: 'website' | 'profile'
  /** A `profile`'s handle (`profile:username`). */
  username?: string
  /** Schema.org, as JSON-LD: one object, its `@context` added here. */
  jsonLd?: Record<string, unknown> | null
  /**
   * The page's other forms (`<link rel="alternate" type=…>`): its RSS and OPML. `href` is a path
   * or an absolute URL.
   */
  feeds?: { type: string; title: string; href: string }[]
}

/** Where the page is, and in which language it was rendered. */
export type HeadPlace = {
  /** `https://telaread.com`: every address in the head is absolute. */
  origin: string
  locale: UiLocale
  /** The address fixes the language (`?hl=`, ADR 0060). */
  pinned: boolean
}

export const escapeHtml = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => `&${{ '&': 'amp', '<': 'lt', '>': 'gt', '"': 'quot', "'": '#39' }[c]};`,
  )

/** JSON inside a `<script>`: nothing in it may close the script, or open a comment. */
export const inScript = (value: unknown) => JSON.stringify(value).replace(/</g, '\\u003c')

/** A path with `?hl=` set to `locale`, or as it is for none. The path never has one already. */
export function withHl(path: string, locale: UiLocale | null): string {
  if (!locale) return path
  return `${path}${path.includes('?') ? '&' : '?'}hl=${locale}`
}

/** The page's addresses: canonical, and one per language with the bare one as `x-default`. */
export function pageAddresses(
  path: string,
  place: HeadPlace,
): { canonical: string; alternates: { hreflang: string; href: string }[] } {
  const at = (locale: UiLocale | null) => `${place.origin}${withHl(path, locale)}`
  return {
    canonical: at(place.pinned ? place.locale : null),
    alternates: [
      ...UI_LOCALES.map((locale) => ({ hreflang: locale, href: at(locale) })),
      { hreflang: 'x-default', href: at(null) },
    ],
  }
}

/** The tags, one per line, in the order they go in the head. */
export function headTags(head: PageHead, place: HeadPlace): string[] {
  const { origin, locale } = place
  const meta = (attr: 'name' | 'property', key: string, value: string) =>
    `<meta ${attr}="${key}" content="${escapeHtml(value)}" />`
  const title = head.title ?? 'Tela'
  const card = `${origin}${shareCardPath(locale)}`
  const tags = [`<title>${escapeHtml(pageTitle(head.title))}</title>`]
  if (head.description) tags.push(meta('name', 'description', head.description))
  if (head.robots) tags.push(meta('name', 'robots', head.robots))
  const addresses = head.path === null ? null : pageAddresses(head.path, place)
  // A page kept out of the index names no canonical and no languages: both are what an index
  // would keep, and saying them beside a noindex sends a search engine two answers.
  if (addresses && !head.robots?.includes('noindex')) {
    tags.push(`<link rel="canonical" href="${escapeHtml(addresses.canonical)}" />`)
    for (const { hreflang, href } of addresses.alternates) {
      tags.push(`<link rel="alternate" hreflang="${hreflang}" href="${escapeHtml(href)}" />`)
    }
  }
  for (const feed of head.feeds ?? []) {
    const href = /^https?:\/\//.test(feed.href) ? feed.href : `${origin}${feed.href}`
    tags.push(
      `<link rel="alternate" type="${escapeHtml(feed.type)}" title="${escapeHtml(feed.title)}" href="${escapeHtml(href)}" />`,
    )
  }
  tags.push(
    meta('property', 'og:site_name', 'Tela'),
    meta('property', 'og:type', head.type ?? 'website'),
    meta('property', 'og:title', title),
  )
  if (head.description) tags.push(meta('property', 'og:description', head.description))
  if (addresses) tags.push(meta('property', 'og:url', addresses.canonical))
  if (head.type === 'profile' && head.username) {
    tags.push(meta('property', 'profile:username', head.username))
  }
  tags.push(meta('property', 'og:locale', OG_LOCALES[locale]))
  for (const other of UI_LOCALES) {
    if (other !== locale) tags.push(meta('property', 'og:locale:alternate', OG_LOCALES[other]))
  }
  tags.push(
    meta('property', 'og:image', card),
    meta('property', 'og:image:width', String(SHARE_CARD.width)),
    meta('property', 'og:image:height', String(SHARE_CARD.height)),
    meta('property', 'og:image:alt', 'Tela'),
    meta('name', 'twitter:card', 'summary_large_image'),
  )
  if (head.jsonLd) {
    tags.push(
      `<script type="application/ld+json">${inScript({ '@context': 'https://schema.org', ...head.jsonLd })}</script>`,
    )
  }
  return tags
}

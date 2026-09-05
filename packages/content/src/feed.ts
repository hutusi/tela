import type { FeedFormat } from '@tela/shared'
import { escapeUTF8 } from 'entities'
import {
  detectAtomFeed,
  detectJsonFeed,
  detectRdfFeed,
  detectRssFeed,
  parseFeed as feedsmithParse,
} from 'feedsmith'
import { absoluteUrl } from './url'

export type ParsedItem = {
  guid: string | null
  url: string | null
  title: string
  author: string | null
  publishedAt: Date | null
  updatedAt: Date | null
  /** Short form: RSS description, Atom summary, JSON summary. */
  summaryHtml: string | null
  /** Full form: content:encoded, Atom content, JSON content_html. */
  contentHtml: string | null
  language: string | null
  imageUrl: string | null
}

export type ParsedFeed = {
  format: FeedFormat
  title: string | null
  description: string | null
  homeUrl: string | null
  selfUrl: string | null
  hubUrl: string | null
  language: string | null
  /** Publisher's suggested polling floor, from <ttl> or sy:updatePeriod. */
  ttlMinutes: number | null
  iconUrl: string | null
  items: ParsedItem[]
}

export class FeedParseError extends Error {
  override name = 'FeedParseError'
}

type Link = { href?: string; rel?: string; type?: string }

function str(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

/** A feed's own title and description are shown and sent to the model; keep them sane. */
export const MAX_FEED_TITLE_CHARS = 300
export const MAX_FEED_DESCRIPTION_CHARS = 2000

function clip(value: string | null, max: number): string | null {
  return value !== null && value.length > max ? `${value.slice(0, max)}…` : value
}

function toDate(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value
  if (typeof value !== 'string' || value.trim() === '') return null
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? null : d
}

function first<T>(values: Array<T | undefined | null> | undefined | null): T | null {
  if (!values) return null
  for (const v of values) if (v !== undefined && v !== null) return v
  return null
}

function abs(value: unknown, base: string): string | null {
  const s = str(value)
  return s ? absoluteUrl(s, base) : null
}

function linkByRel(links: Array<Link | undefined> | undefined, rel: string): string | null {
  if (!links) return null
  for (const l of links) {
    if (l?.href && (l.rel ?? 'alternate') === rel) return l.href
  }
  return null
}

function alternateLink(links: Array<Link | undefined> | undefined): string | null {
  if (!links) return null
  const html = links.find(
    (l) =>
      l?.href && (l.rel ?? 'alternate') === 'alternate' && (!l.type || l.type.includes('html')),
  )
  return html?.href ?? linkByRel(links, 'alternate')
}

function syToMinutes(
  sy: { updatePeriod?: string; updateFrequency?: number } | undefined,
): number | null {
  if (!sy?.updatePeriod) return null
  const periods: Record<string, number> = {
    hourly: 60,
    daily: 1440,
    weekly: 10080,
    monthly: 43200,
    yearly: 525600,
  }
  const base = periods[sy.updatePeriod.toLowerCase()]
  if (!base) return null
  const freq = sy.updateFrequency && sy.updateFrequency > 0 ? sy.updateFrequency : 1
  return Math.round(base / freq)
}

function textToHtml(text: string): string {
  return text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${escapeUTF8(p).replace(/\n/g, '<br>')}</p>`)
    .join('')
}

function personName(p: unknown): string | null {
  if (typeof p === 'string') return str(p)
  if (p && typeof p === 'object' && 'name' in p) return str((p as { name?: unknown }).name)
  return null
}

/** True when the text is recognizably RSS, Atom, RDF, or JSON Feed. */
export function looksLikeFeed(text: string): boolean {
  return detectRssFeed(text) || detectAtomFeed(text) || detectJsonFeed(text) || detectRdfFeed(text)
}

/** Parse any supported feed format into Tela's normalized shape. Throws FeedParseError. */
export function parseFeedText(text: string, feedUrl: string): ParsedFeed {
  let parsed: ReturnType<typeof feedsmithParse>
  try {
    parsed = feedsmithParse(text)
  } catch (err) {
    throw new FeedParseError(err instanceof Error ? err.message : 'unrecognized feed')
  }

  if (parsed.format === 'rss') {
    const f = parsed.feed
    const homeUrl = abs(f.link, feedUrl) ?? abs(alternateLink(f.atom?.links), feedUrl)
    const base = homeUrl ?? feedUrl
    return {
      format: 'rss',
      title: clip(str(f.title), MAX_FEED_TITLE_CHARS),
      description: clip(str(f.description), MAX_FEED_DESCRIPTION_CHARS),
      homeUrl,
      selfUrl: abs(linkByRel(f.atom?.links, 'self'), feedUrl),
      hubUrl: abs(linkByRel(f.atom?.links, 'hub'), feedUrl),
      language: str(f.language) ?? str(first(f.dc?.languages)) ?? str(f.dc?.language),
      ttlMinutes: typeof f.ttl === 'number' && f.ttl > 0 ? f.ttl : syToMinutes(f.sy),
      iconUrl: abs(f.image?.url, base),
      items: (f.items ?? []).map((item): ParsedItem => {
        const url = abs(item.link, base) ?? abs(alternateLink(item.atom?.links), base)
        const guid = str(item.guid?.value)
        const enclosureImage = item.enclosures?.find((e) => e?.type?.startsWith('image/'))
        return {
          guid,
          url: url ?? (guid && item.guid?.isPermaLink !== false ? absoluteUrl(guid, base) : null),
          title: str(item.title) ?? '',
          author:
            personName(first(item.authors)) ??
            str(first(item.dc?.creators)) ??
            str(item.dc?.creator),
          publishedAt:
            toDate(item.pubDate) ?? toDate(first(item.dc?.dates)) ?? toDate(item.dc?.date),
          updatedAt: toDate(item.atom?.updated),
          summaryHtml: str(item.description),
          contentHtml: str(item.content?.encoded),
          language: str(first(item.dc?.languages)) ?? str(item.dc?.language),
          imageUrl: abs(enclosureImage?.url, base),
        }
      }),
    }
  }

  if (parsed.format === 'atom') {
    const f = parsed.feed
    const homeUrl = abs(alternateLink(f.links), feedUrl)
    const base = homeUrl ?? feedUrl
    return {
      format: 'atom',
      title: clip(str(f.title), MAX_FEED_TITLE_CHARS),
      description: clip(str(f.subtitle), MAX_FEED_DESCRIPTION_CHARS),
      homeUrl,
      selfUrl: abs(linkByRel(f.links, 'self'), feedUrl),
      hubUrl: abs(linkByRel(f.links, 'hub'), feedUrl),
      language: str(first(f.dc?.languages)) ?? str(f.dc?.language),
      ttlMinutes: syToMinutes(f.sy),
      iconUrl: abs(f.icon, base) ?? abs(f.logo, base),
      items: (f.entries ?? []).map((entry): ParsedItem => {
        const url = abs(alternateLink(entry.links), base)
        return {
          guid: str(entry.id),
          url,
          title: str(entry.title) ?? '',
          author: personName(first(entry.authors)) ?? personName(first(f.authors)),
          publishedAt: toDate(entry.published) ?? toDate(entry.updated),
          updatedAt: toDate(entry.updated),
          summaryHtml: str(entry.summary),
          contentHtml: str(entry.content),
          language: str(first(entry.dc?.languages)),
          imageUrl: null,
        }
      }),
    }
  }

  if (parsed.format === 'json') {
    const f = parsed.feed
    const homeUrl = abs(f.home_page_url, feedUrl)
    const base = homeUrl ?? feedUrl
    return {
      format: 'json',
      title: clip(str(f.title), MAX_FEED_TITLE_CHARS),
      description: clip(str(f.description), MAX_FEED_DESCRIPTION_CHARS),
      homeUrl,
      selfUrl: abs(f.feed_url, feedUrl),
      hubUrl: abs(first(f.hubs)?.url, feedUrl),
      language: str(f.language),
      ttlMinutes: null,
      iconUrl: abs(f.icon, base) ?? abs(f.favicon, base),
      items: (f.items ?? []).map((item): ParsedItem => {
        const contentHtml = str(item.content_html)
        const contentText = str(item.content_text)
        return {
          guid: str(item.id),
          url: abs(item.url, base) ?? abs(item.external_url, base),
          title: str(item.title) ?? '',
          author: personName(first(item.authors)) ?? personName(first(f.authors)),
          publishedAt: toDate(item.date_published),
          updatedAt: toDate(item.date_modified),
          summaryHtml: str(item.summary),
          contentHtml: contentHtml ?? (contentText ? textToHtml(contentText) : null),
          language: str(item.language),
          imageUrl: abs(item.image, base) ?? abs(item.banner_image, base),
        }
      }),
    }
  }

  const f = parsed.feed
  const homeUrl = abs(f.link, feedUrl)
  const base = homeUrl ?? feedUrl
  return {
    format: 'rdf',
    title: clip(str(f.title), MAX_FEED_TITLE_CHARS),
    description: clip(str(f.description), MAX_FEED_DESCRIPTION_CHARS),
    homeUrl,
    selfUrl: abs(linkByRel(f.atom?.links, 'self'), feedUrl),
    hubUrl: null,
    language: str(first(f.dc?.languages)) ?? str(f.dc?.language),
    ttlMinutes: syToMinutes(f.sy),
    iconUrl: abs(f.image?.url, base),
    items: (f.items ?? []).map(
      (item): ParsedItem => ({
        guid: str(item.rdf?.about) ?? null,
        url: abs(item.link, base),
        title: str(item.title) ?? '',
        author: str(first(item.dc?.creators)) ?? str(item.dc?.creator),
        publishedAt: toDate(first(item.dc?.dates)) ?? toDate(item.dc?.date),
        updatedAt: null,
        summaryHtml: str(item.description),
        contentHtml: str(item.content?.encoded),
        language: str(first(item.dc?.languages)),
        imageUrl: null,
      }),
    ),
  }
}

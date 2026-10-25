/**
 * RSS 2.0 out: Tela's own pages as feeds (ADR 0062), a blogroll's blogs' posts and Discover's
 * newest. Pure and runtime-agnostic: the edge renders these from tela-api's public JSON.
 *
 * An item points at the post where its writer published it and carries what a public page shows
 * of it, never more: a title, the excerpt as plain text, the blog's name and the date. Never a
 * body.
 */
import { xmlEscape as xml, xmlEscapeHtmlText } from './xml'

export type RssItem = {
  /** The post's own address: the item's link and its guid. */
  link: string
  title: string
  /** Plain text, shown as text: escaped for HTML as well as XML. */
  description?: string | null
  /** The blog's name (`dc:creator`, and `source` when its feed is known). */
  creator?: string | null
  /** The blog's own feed, for `source`. */
  sourceUrl?: string | null
  /** Epoch milliseconds. */
  date: number
}

export type RssChannel = {
  title: string
  /** The page on Tela the feed is of. */
  link: string
  description: string
  /** The feed's own address (`atom:link rel="self"`). */
  self: string
  /** The language its titles are in, when one is: a feed of originals has none. */
  language?: string | null
  items: RssItem[]
}

const RSS_NAMESPACES =
  'xmlns:atom="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/elements/1.1/"'

/** RFC 822, as RSS dates are written: `Sun, 25 Oct 2026 12:00:00 GMT`. */
const rfc822 = (ms: number) => new Date(ms).toUTCString()

/**
 * An RSS 2.0 document. `lastBuildDate` is the newest item's date, not the time it was rendered,
 * so the same items make the same bytes and a conditional GET can answer 304. An item with no
 * title is titled by its link: RSS asks for a title or a description, and a reader lists items by
 * their title.
 */
export function buildRss(channel: RssChannel): string {
  const newest = channel.items.reduce((at, i) => Math.max(at, i.date), Number.NEGATIVE_INFINITY)
  const head = [
    `    <title>${xml(channel.title)}</title>`,
    `    <link>${xml(channel.link)}</link>`,
    `    <description>${xml(channel.description)}</description>`,
    `    <atom:link href="${xml(channel.self)}" rel="self" type="application/rss+xml"/>`,
    ...(channel.language ? [`    <language>${xml(channel.language)}</language>`] : []),
    ...(Number.isFinite(newest) ? [`    <lastBuildDate>${rfc822(newest)}</lastBuildDate>`] : []),
    '    <generator>Tela</generator>',
  ]
  const items = channel.items.map((i) => {
    const title = i.title.trim() || i.link
    const description = i.description?.trim()
    const creator = i.creator?.trim()
    return [
      '    <item>',
      `      <title>${xml(title)}</title>`,
      `      <link>${xml(i.link)}</link>`,
      `      <guid isPermaLink="true">${xml(i.link)}</guid>`,
      ...(description
        ? [`      <description>${xmlEscapeHtmlText(description)}</description>`]
        : []),
      ...(creator ? [`      <dc:creator>${xml(creator)}</dc:creator>`] : []),
      ...(creator && i.sourceUrl
        ? [`      <source url="${xml(i.sourceUrl)}">${xml(creator)}</source>`]
        : []),
      `      <pubDate>${rfc822(i.date)}</pubDate>`,
      '    </item>',
    ].join('\n')
  })
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" ${RSS_NAMESPACES}>
  <channel>
${[...head, ...items].join('\n')}
  </channel>
</rss>
`
}

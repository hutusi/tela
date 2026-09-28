/**
 * OPML in and out: the one exchange format feed readers share, so a member can arrive with their
 * subscriptions and leave with them (the owner's third requirement, applied to members).
 */
import { parseOpml } from 'feedsmith'

/** An OPML export is a few KB per hundred feeds; anything near this is not a subscription list. */
export const MAX_OPML_BYTES = 1024 * 1024
export const MAX_OPML_FEEDS = 500
/** Readers nest folders a few levels deep; deeper trees are not worth walking. */
export const MAX_OPML_DEPTH = 20

type Outline = { xmlUrl?: string; outlines?: Outline[] }

/**
 * The http(s) feed URLs of an OPML document, in document order, deduplicated and capped at
 * MAX_OPML_FEEDS. Outlines nested deeper than MAX_OPML_DEPTH are ignored. Throws on input that
 * is not OPML.
 */
export function feedUrlsFromOpml(text: string): string[] {
  const doc = parseOpml(text) as { body?: { outlines?: Outline[] } }
  const urls = new Set<string>()
  const walk = (outlines: Outline[] | undefined, depth: number) => {
    if (!outlines || depth > MAX_OPML_DEPTH) return
    for (const o of outlines) {
      if (urls.size >= MAX_OPML_FEEDS) return
      if (o.xmlUrl && /^https?:\/\//.test(o.xmlUrl)) urls.add(o.xmlUrl)
      walk(o.outlines, depth + 1)
    }
  }
  walk(doc.body?.outlines, 0)
  return [...urls]
}

const xml = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c] as string,
  )

export type OpmlFeed = { feedUrl: string; title: string; homeUrl: string }

/** An OPML 2.0 document of the given feeds, in the order given. */
export function buildOpml(feeds: OpmlFeed[], createdAt: Date): string {
  const outlines = feeds
    .map((f) => {
      const text = xml(f.title)
      return `    <outline type="rss" text="${text}" title="${text}" xmlUrl="${xml(f.feedUrl)}" htmlUrl="${xml(f.homeUrl)}"/>`
    })
    .join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
  <head>
    <title>Tela subscriptions</title>
    <dateCreated>${createdAt.toUTCString()}</dateCreated>
  </head>
  <body>
${outlines}
  </body>
</opml>
`
}

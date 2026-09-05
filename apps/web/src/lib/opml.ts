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

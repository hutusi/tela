/**
 * OPML in and out: the one exchange format feed readers share, so a member can arrive with their
 * subscriptions and leave with them (the owner's third requirement, applied to members), and
 * with the folders they kept them in (ADR 0048). Tela's own pages are offered as OPML too: a
 * blogroll and Discover's blogs (ADR 0062).
 */
import { folderName } from '@tela/shared'
import { parseOpml } from 'feedsmith'
import { xmlEscape as xml } from './xml'

/** An OPML export is a few KB per hundred feeds; anything near this is not a subscription list. */
export const MAX_OPML_BYTES = 1024 * 1024
export const MAX_OPML_FEEDS = 500
/** Readers nest folders a few levels deep; deeper trees are not worth walking. */
export const MAX_OPML_DEPTH = 20

type Outline = { text?: string; title?: string; xmlUrl?: string; outlines?: Outline[] }

/** A feed an OPML document lists, and the folder it lists it in: null is none. */
export type OpmlEntry = { url: string; folder: string | null }

/**
 * The http(s) feeds of an OPML document, in document order, deduplicated by URL (the first one
 * listed wins, folder and all) and capped at MAX_OPML_FEEDS. Outlines nested deeper than
 * MAX_OPML_DEPTH are ignored. Throws on input that is not OPML.
 *
 * A feed's folder is the nearest outline around it that is not itself a feed, named by its
 * `text`, else its `title`, as a folder name is kept. Tela's folders are flat, so a feed in
 * "Tech › Rust" is in "Rust"; and one whose nearest folder has no name is in none, rather than in
 * a folder further out that the member did not put it in.
 */
export function feedsFromOpml(text: string): OpmlEntry[] {
  const doc = parseOpml(text) as { body?: { outlines?: Outline[] } }
  const seen = new Set<string>()
  const feeds: OpmlEntry[] = []
  const walk = (outlines: Outline[] | undefined, depth: number, folder: string | null) => {
    if (!outlines || depth > MAX_OPML_DEPTH) return
    for (const o of outlines) {
      if (feeds.length >= MAX_OPML_FEEDS) return
      if (o.xmlUrl) {
        if (/^https?:\/\//.test(o.xmlUrl) && !seen.has(o.xmlUrl)) {
          seen.add(o.xmlUrl)
          feeds.push({ url: o.xmlUrl, folder })
        }
        // A feed is no folder: whatever a reader nested under one stays in the folder around it.
        walk(o.outlines, depth + 1, folder)
      } else {
        walk(o.outlines, depth + 1, folderName(o.text ?? o.title ?? '') || null)
      }
    }
  }
  walk(doc.body?.outlines, 0, null)
  return feeds
}

/** The feed URLs of an OPML document, as `feedsFromOpml` reads them, without their folders. */
export function feedUrlsFromOpml(text: string): string[] {
  return feedsFromOpml(text).map((f) => f.url)
}

export type OpmlFeed = { feedUrl: string; title: string; homeUrl: string; folder?: string | null }

/**
 * What an OPML document says about itself (OPML 2.0's `head`): its title and, each only when
 * given, when it was made and last changed, and who keeps it, by name and by the address of a page
 * about them (`ownerId`). A member's export is "Tela subscriptions", made now; a blogroll's is its
 * own name, changed when it last changed, kept by its owner (ADR 0062).
 */
export type OpmlHead = {
  title: string
  dateCreated?: Date
  dateModified?: Date
  ownerName?: string
  ownerId?: string
}

/**
 * An OPML 2.0 document of the given feeds: one outline per folder, where its first feed is, holding
 * its feeds in the order given; then the feeds in no folder, in the order given.
 */
export function buildOpml(feeds: OpmlFeed[], head: OpmlHead): string {
  const outline = (f: OpmlFeed, indent: string) => {
    const text = xml(f.title)
    return `${indent}<outline type="rss" text="${text}" title="${text}" xmlUrl="${xml(f.feedUrl)}" htmlUrl="${xml(f.homeUrl)}"/>`
  }
  const folders = new Map<string, OpmlFeed[]>()
  const loose: OpmlFeed[] = []
  for (const f of feeds) {
    if (!f.folder) {
      loose.push(f)
      continue
    }
    const held = folders.get(f.folder)
    if (held) held.push(f)
    else folders.set(f.folder, [f])
  }
  const lines = [
    ...[...folders].flatMap(([name, held]) => [
      `    <outline text="${xml(name)}" title="${xml(name)}">`,
      ...held.map((f) => outline(f, '      ')),
      '    </outline>',
    ]),
    ...loose.map((f) => outline(f, '    ')),
  ]
  return `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
  <head>
${headLines(head).join('\n')}
  </head>
  <body>
${lines.join('\n')}
  </body>
</opml>
`
}

function headLines(head: OpmlHead): string[] {
  const line = (name: string, value: string | undefined) =>
    value === undefined ? [] : [`    <${name}>${xml(value)}</${name}>`]
  return [
    ...line('title', head.title),
    ...line('dateCreated', head.dateCreated?.toUTCString()),
    ...line('dateModified', head.dateModified?.toUTCString()),
    ...line('ownerName', head.ownerName),
    ...line('ownerId', head.ownerId),
  ]
}

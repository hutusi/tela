/**
 * Content objects: an article body in the form readers receive it, built once at ingest and
 * stored immutably under its content key (`c/<key>.json`, ADR 0022).
 *
 * Everything a reader used to pay for on every open happens here once: the body is already split
 * into top-level blocks for the paired reader (ADR 0019), each carrying its leaf `data-tb` ids for
 * translation and highlights, and every image is rewritten to `/img/<key>/<index>`. The proxy
 * resolves that index against this object's own `images`, so it can only fetch URLs that appear
 * in stored content, with no signing secret to rotate.
 *
 * The object holds nothing specific to one article, so two articles with the same body share one.
 */
import { NORM_VERSION } from '@tela/shared'
import { type Element, isTag } from 'domhandler'
import { findAll } from 'domutils'
import { parseDocument } from 'htmlparser2'
import type { ProcessedContent } from './process'
import { blocksOf } from './split'

export const OBJECT_FORMAT = 1

export type ContentBlock = {
  /** Tag of the top-level element, or `#text` for a stray run. */
  tag: string
  /** Its sanitized, annotated HTML, images already pointing at the proxy. */
  html: string
  /** The leaf `data-tb` ids inside it, in document order. */
  leaves: string[]
}

export type LeafInfo = { hash: string; chars: number; skip?: true }

export type ContentObject = {
  format: typeof OBJECT_FORMAT
  /** NORM_VERSION the leaves were annotated under. */
  norm: number
  key: string
  lang: string
  blocks: ContentBlock[]
  leaves: Record<string, LeafInfo>
  /** Original image URLs, addressed as `/img/<key>/<index>`. */
  images: string[]
  stats: { chars: number; words: number; minutes: number }
}

/** A content object's key: the first 128 bits of the annotated HTML's hash, original URLs and all. */
export function contentKeyOf(processed: Pick<ProcessedContent, 'contentHash'>): string {
  return processed.contentHash.slice(0, 32)
}

export function imageProxyPath(key: string, index: number): string {
  return `/img/${key}/${index}`
}

/**
 * Point every http(s) `<img>` at the proxy by index, in document order, reusing one index for a
 * URL that appears twice. Returns the URL list the indexes refer to.
 */
export function indexImagesIn(doc: ReturnType<typeof parseDocument>, key: string): string[] {
  const images: string[] = []
  const seen = new Map<string, number>()
  for (const img of findAll((el): el is Element => isTag(el) && el.name === 'img', doc.children)) {
    const src = img.attribs.src
    if (!src || !/^https?:\/\//i.test(src)) continue
    let index = seen.get(src)
    if (index === undefined) {
      index = images.length
      images.push(src)
      seen.set(src, index)
    }
    img.attribs['data-origin'] = new URL(src).hostname
    img.attribs.src = imageProxyPath(key, index)
  }
  return images
}

/** Build the content object for a processed body (one parse, no I/O). */
export function buildContentObject(processed: ProcessedContent): ContentObject {
  const key = contentKeyOf(processed)
  const doc = parseDocument(processed.html)
  const images = indexImagesIn(doc, key)
  const leaves: Record<string, LeafInfo> = {}
  for (const b of processed.blocks) {
    leaves[b.id] = { hash: b.hash, chars: b.chars, ...(b.skip ? { skip: true as const } : {}) }
  }
  return {
    format: OBJECT_FORMAT,
    norm: NORM_VERSION,
    key,
    lang: processed.lang,
    blocks: blocksOf(doc).map((b) => ({ tag: b.tag, html: b.html, leaves: b.ids })),
    leaves,
    images,
    stats: {
      chars: processed.text.length,
      words: processed.wordCount,
      minutes: processed.readingMinutes,
    },
  }
}

/** Blob keys (ADR 0022). */
export const objectKeys = {
  content: (key: string) => `c/${key}.json`,
  raw: (sha: string) => `r/${sha}.html`,
} as const

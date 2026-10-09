import type { ContentMode, ExtractedFrom } from '@tela/shared'

export type ContentSample = {
  /** Plain-text length of the processed body. */
  chars: number
  /** Whether the feed supplied a full-content field (content:encoded, Atom content, content_html). */
  hadFullContent: boolean
  /** Plain text tail, for "read more" detection. */
  tail: string
  /** Whether the body ends with a jump link to its own page (`endsWithJumpLink`). */
  jumpLink: boolean
}

/**
 * A "read more" tail in the list's languages, with what themes put after it (`Read more »`), and
 * the elisions excerpts end with (`…`, WordPress's `[...]`). Missing one is silent: the feed is
 * learned as full once and for good, and its readers get the excerpt as the post.
 */
const READ_MORE =
  /(read more|continue reading|阅读全文|閱讀全文|查看全文|继续阅读|繼續閱讀|続きを読む|더 보기|leer más|lire la suite|la suite par ici|weiterlesen|leia mais|continua a leggere|\.{3}|…|\[(?:\.{3}|…)\])[\s»›→>]*$/i

/** The fragment Blogger's jump break (`#more`) and WordPress's more tag (`#more-123`) link to. */
const JUMP = /^#more(?:-\d+)?$/

/** The few entities a "read more" link's text is written with. */
const ENTITIES: Record<string, string> = {
  '&raquo;': '»',
  '&#187;': '»',
  '&rsaquo;': '›',
  '&rarr;': '→',
  '&hellip;': '…',
  '&#8230;': '…',
  '&nbsp;': ' ',
  '&#160;': ' ',
  '&amp;': '&',
}

/**
 * Whether the body ends with a link to the rest of itself: the item's own page, either at
 * `#more`, as Blogger and WordPress cut an excerpt whatever its language says ("… la suite par
 * ici"), or under a "read more" label or an elision (kexue.fm's `[...]`). Read from the raw HTML,
 * since processing drops a paragraph that is nothing but a link. A full post that ends with its
 * permalink (Daring Fireball's ★) has neither.
 */
export function endsWithJumpLink(html: string, itemUrl: string | null): boolean {
  if (!itemUrl) return false
  // The end is enough, and a regex over the whole of a long body is not.
  const end = html.slice(-1500)
  const open = [...end.matchAll(/<a\b/gi)].at(-1)?.index
  if (open === undefined) return false
  const close = end.toLowerCase().indexOf('</a>', open)
  const tagEnd = end.indexOf('>', open)
  if (close < 0 || tagEnd < 0 || tagEnd > close) return false
  if (!/^(?:\s|<\/?(?:p|div|span|br)\b[^>]*>)*$/i.test(end.slice(close + 4))) return false
  const href = /\bhref\s*=\s*(["'])(.*?)\1/i.exec(end.slice(open, tagEnd))?.[2]
  if (!href) return false
  const label = end
    .slice(tagEnd + 1, close)
    .replace(/<[^>]*>/g, '')
    .replace(/&[#a-z0-9]+;/gi, (e) => ENTITIES[e.toLowerCase()] ?? e)
    .trim()
  try {
    const link = new URL(href.replaceAll('&amp;', '&'), itemUrl)
    const page = new URL(itemUrl)
    if (link.host !== page.host || link.pathname !== page.pathname) return false
    return JUMP.test(link.hash) || READ_MORE.test(label)
  } catch {
    return false
  }
}

export const SUMMARY_MAX_CHARS = 600
export const MIN_SAMPLES = 3

/** What the reader knows about an article when deciding whether to fetch its page. */
export type ExtractionCandidate = {
  contentMode: ContentMode
  extractedFrom: ExtractedFrom
  extractCheckedAt: Date | null
  /** Plain-text length of the body, skipped blocks excluded. */
  bodyChars: number
}

/**
 * Whether opening this article should queue full-text extraction: once, while the content
 * still comes from the feed, when the feed is known to ship summaries, or when the feed was too
 * small to classify (fewer than MIN_SAMPLES items) and this body is summary-sized.
 */
export function wantsExtraction(article: ExtractionCandidate): boolean {
  if (article.extractedFrom !== 'feed' || article.extractCheckedAt !== null) return false
  if (article.contentMode === 'summary') return true
  if (article.contentMode !== 'unknown') return false
  return article.bodyChars < SUMMARY_MAX_CHARS
}

/**
 * Decide whether a feed ships full articles or only summaries. Needs at least three
 * samples; otherwise stays unknown. Summary when the median body is short, when no
 * item had a full-content field, or when most bodies end with a "read more" tail or a jump link.
 */
export function learnContentMode(samples: ContentSample[]): ContentMode {
  if (samples.length < MIN_SAMPLES) return 'unknown'
  const sorted = [...samples].map((s) => s.chars).sort((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0
  const anyFull = samples.some((s) => s.hadFullContent)
  const readMore = samples.filter((s) => s.jumpLink || READ_MORE.test(s.tail.trim())).length
  if (!anyFull && median < SUMMARY_MAX_CHARS) return 'summary'
  if (median < SUMMARY_MAX_CHARS / 2) return 'summary'
  if (readMore > samples.length / 2) return 'summary'
  return 'full'
}

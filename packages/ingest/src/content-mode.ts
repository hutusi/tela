import type { ContentMode, ExtractedFrom } from '@tela/shared'

export type ContentSample = {
  /** Plain-text length of the processed body. */
  chars: number
  /** Whether the feed supplied a full-content field (content:encoded, Atom content, content_html). */
  hadFullContent: boolean
  /** Plain text tail, for "read more" detection. */
  tail: string
}

const READ_MORE =
  /(read more|continue reading|阅读全文|查看全文|続きを読む|더 보기|leer más|\.{3}|…)\s*$/i

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
 * item had a full-content field, or when most bodies end with a "read more" tail.
 */
export function learnContentMode(samples: ContentSample[]): ContentMode {
  if (samples.length < MIN_SAMPLES) return 'unknown'
  const sorted = [...samples].map((s) => s.chars).sort((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0
  const anyFull = samples.some((s) => s.hadFullContent)
  const readMore = samples.filter((s) => READ_MORE.test(s.tail.trim())).length
  if (!anyFull && median < SUMMARY_MAX_CHARS) return 'summary'
  if (median < SUMMARY_MAX_CHARS / 2) return 'summary'
  if (readMore > samples.length / 2) return 'summary'
  return 'full'
}

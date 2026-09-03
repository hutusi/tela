const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** Plain-text excerpt from the leading paragraphs, cut on a word boundary when possible. */
export function makeExcerpt(paragraphs: string[], maxChars = 280): string {
  const joined = collapse(paragraphs.filter((p) => p.trim()).join(' '))
  if (joined.length <= maxChars) return joined
  const window = joined.slice(0, maxChars)
  const lastSpace = window.lastIndexOf(' ')
  const cjkHeavy = (window.match(CJK) ?? []).length > window.length / 3
  const cut = !cjkHeavy && lastSpace > maxChars * 0.6 ? window.slice(0, lastSpace) : window
  return `${cut.replace(/[\s,;:，、；：]+$/u, '')}…`
}

/** CJK characters count as words; everything else is split on whitespace. */
export function wordCount(text: string): number {
  const cjk = (text.match(CJK) ?? []).length
  const rest = text.replace(CJK, ' ')
  const words = rest.split(/\s+/).filter((w) => /\p{L}|\p{N}/u.test(w)).length
  return cjk + words
}

/** Reading time: ~400 CJK characters or ~230 words per minute, never below one minute. */
export function readingMinutes(text: string): number {
  const cjk = (text.match(CJK) ?? []).length
  const words = wordCount(text) - cjk
  const minutes = cjk / 400 + words / 230
  return Math.max(1, Math.round(minutes))
}

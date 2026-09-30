/**
 * Where a highlight is (ADR 0026). An anchor names one leaf (a paragraph, list item, cell: an
 * element with a `data-tb` id) and offsets into its text, and keeps the quote and a little of the
 * text either side. That is enough to find the passage again when the post changes:
 *
 * 1. The same leaf still holds the quote at the same offsets: it is where it was.
 * 2. Otherwise every occurrence of the quote in the post is a candidate, scored by how much of the
 *    remembered context surrounds it, with a bonus for the leaf it used to be in. The best one
 *    wins, unless there are several and hardly any context matches the best (a space either side
 *    is not context): a "the" found at random is worse than admitting the passage is gone.
 * 3. No occurrence at all: detached. The member still sees the quote and their note.
 *
 * The quote is always re-checked, even for a leaf whose id is unchanged: a repeated block's id
 * carries a position suffix (`-2`, `-3`), so the same id can name different text after an edit.
 *
 * Pure functions over leaf texts, so the rules are tested without a browser.
 */
import { HIGHLIGHT_CONTEXT } from '@tela/shared'

export type Anchor = {
  leafId: string
  start: number
  end: number
  quote: string
  prefix: string
  suffix: string
}

export type Resolved =
  | { status: 'exact' | 'moved'; leafId: string; start: number; end: number }
  | { status: 'detached' }

/** The quote and its context for a range of a leaf's text. */
export function anchorIn(leafId: string, text: string, start: number, end: number): Anchor {
  return {
    leafId,
    start,
    end,
    quote: text.slice(start, end),
    prefix: text.slice(Math.max(0, start - HIGHLIGHT_CONTEXT), start),
    suffix: text.slice(end, end + HIGHLIGHT_CONTEXT),
  }
}

/** How many characters before `at` match the end of `prefix`. */
function before(text: string, at: number, prefix: string): number {
  let n = 0
  while (n < prefix.length && at - 1 - n >= 0 && text[at - 1 - n] === prefix[prefix.length - 1 - n])
    n++
  return n
}

/** How many characters from `at` match the start of `suffix`. */
function after(text: string, at: number, suffix: string): number {
  let n = 0
  while (n < suffix.length && at + n < text.length && text[at + n] === suffix[n]) n++
  return n
}

/** Where a remembered passage is in the post as it is now: `leaves` in document order. */
export function resolveAnchor(anchor: Anchor, leaves: ReadonlyMap<string, string>): Resolved {
  const { leafId, start, end, quote, prefix, suffix } = anchor
  if (!quote) return { status: 'detached' }
  if (leaves.get(leafId)?.slice(start, end) === quote)
    return { status: 'exact', leafId, start, end }

  type Candidate = { leafId: string; start: number; context: number; score: number }
  const candidates: Candidate[] = []
  for (const [id, text] of leaves) {
    for (let at = text.indexOf(quote); at !== -1; at = text.indexOf(quote, at + 1)) {
      const context = before(text, at, prefix) + after(text, at + quote.length, suffix)
      // Staying in its leaf counts for something, and so does staying near where it was.
      const home = id === leafId ? 8 - Math.min(7, Math.floor(Math.abs(at - start) / 40)) : 0
      candidates.push({ leafId: id, start: at, context, score: context + home })
    }
  }
  if (candidates.length === 0) return { status: 'detached' }
  candidates.sort((a, b) => b.score - a.score)
  const best = candidates[0] as Candidate
  // A space either side matches almost anywhere: context counts from a few characters on.
  const weak = best.context < Math.min(4, prefix.length + suffix.length)
  if (candidates.length > 1 && weak) return { status: 'detached' }
  return { status: 'moved', leafId: best.leafId, start: best.start, end: best.start + quote.length }
}

/** Whether a resolution means the stored anchor should be rewritten. */
export function anchorChanged(anchor: Anchor, resolved: Resolved): boolean {
  return (
    resolved.status === 'moved' &&
    (resolved.leafId !== anchor.leafId ||
      resolved.start !== anchor.start ||
      resolved.end !== anchor.end)
  )
}

/**
 * Highlights on the page (ADR 0026). They are painted with the CSS Custom Highlight API, so the
 * sanitized article DOM is never touched: a highlight is a `Range` over text the page already
 * rendered, registered under a name the stylesheet colours (`::highlight(tela-highlight)`).
 *
 * A leaf is an element with a `data-tb` id; its side is the column it sits in, original or
 * translation. Offsets count characters of the leaf's `textContent`, which is what the anchor's
 * offsets and quote are measured in.
 */
import { type Anchor, anchorIn } from './anchor'

export type Side = 'original' | 'translation'

const COLUMN = '[data-testid="body-original"], [data-testid="body-translated"]'
const sideOf = (column: Element): Side =>
  column.getAttribute('data-testid') === 'body-original' ? 'original' : 'translation'

/** The leaves one side of the article renders, by id, in document order. */
export function renderedLeaves(root: HTMLElement, side: Side): Map<string, HTMLElement> {
  const out = new Map<string, HTMLElement>()
  for (const column of root.querySelectorAll(COLUMN)) {
    if (sideOf(column) !== side) continue
    for (const leaf of column.querySelectorAll<HTMLElement>('[data-tb]')) {
      const id = leaf.getAttribute('data-tb')
      if (id && !out.has(id)) out.set(id, leaf)
    }
  }
  return out
}

export const textsOf = (leaves: Map<string, HTMLElement>) =>
  new Map([...leaves].map(([id, el]) => [id, el.textContent ?? '']))

/** Characters of `leaf`'s text before a DOM point inside it. */
function offsetIn(leaf: Node, node: Node, offset: number): number {
  const range = document.createRange()
  range.setStart(leaf, 0)
  range.setEnd(node, offset)
  return range.toString().length
}

const elementOf = (node: Node): Element | null =>
  node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement

/**
 * What the reader has selected in the article, as an anchor: one leaf's worth, from where the
 * selection starts (a highlight lives in one paragraph, list item or cell), trimmed of the space
 * either end. Null outside the article or for an empty selection.
 */
export function selectedAnchor(
  root: HTMLElement,
): { side: Side; anchor: Anchor; rect: DOMRect } | null {
  const selection = window.getSelection()
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null
  const range = selection.getRangeAt(0)
  const leaf = elementOf(range.startContainer)?.closest<HTMLElement>('[data-tb]')
  const column = leaf?.closest(COLUMN)
  if (!leaf || !column || !root.contains(leaf)) return null
  const text = leaf.textContent ?? ''
  let start = offsetIn(leaf, range.startContainer, range.startOffset)
  let end = leaf.contains(range.endContainer)
    ? offsetIn(leaf, range.endContainer, range.endOffset)
    : text.length
  while (start < end && /\s/.test(text[start] ?? '')) start++
  while (end > start && /\s/.test(text[end - 1] ?? '')) end--
  const id = leaf.getAttribute('data-tb')
  if (!id || end <= start) return null
  return {
    side: sideOf(column),
    anchor: anchorIn(id, text, start, end),
    rect: range.getBoundingClientRect(),
  }
}

/** A range over characters `start`–`end` of a leaf's text. */
export function rangeIn(leaf: HTMLElement, start: number, end: number): Range | null {
  const walker = document.createTreeWalker(leaf, NodeFilter.SHOW_TEXT)
  const range = document.createRange()
  let at = 0
  let started = false
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const length = (node as Text).data.length
    if (!started && start < at + length) {
      range.setStart(node, start - at)
      started = true
    }
    if (started && end <= at + length) {
      range.setEnd(node, end - at)
      return range
    }
    at += length
  }
  return null
}

/** Whether this browser can paint highlights at all (Chrome 105, Safari 17.2, Firefox 140). */
export const canPaint = () =>
  typeof CSS !== 'undefined' && 'highlights' in CSS && typeof Highlight === 'function'

export function paint(ranges: Range[], active: Range[]): void {
  if (!canPaint()) return
  CSS.highlights.set('tela-highlight', new Highlight(...ranges))
  CSS.highlights.set('tela-highlight-active', new Highlight(...active))
}

export function unpaint(): void {
  if (!canPaint()) return
  CSS.highlights.delete('tela-highlight')
  CSS.highlights.delete('tela-highlight-active')
}

/** The leaf and text offset under a point: what a click on painted text landed on. */
export function pointAt(
  x: number,
  y: number,
): { side: Side; leafId: string; offset: number } | null {
  const doc = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null
    caretRangeFromPoint?: (x: number, y: number) => Range | null
  }
  const position = doc.caretPositionFromPoint?.(x, y)
  const caret = position
    ? { node: position.offsetNode, offset: position.offset }
    : (() => {
        const range = doc.caretRangeFromPoint?.(x, y)
        return range ? { node: range.startContainer, offset: range.startOffset } : null
      })()
  if (!caret) return null
  const leaf = elementOf(caret.node)?.closest<HTMLElement>('[data-tb]')
  const column = leaf?.closest(COLUMN)
  const id = leaf?.getAttribute('data-tb')
  if (!leaf || !column || !id) return null
  return { side: sideOf(column), leafId: id, offset: offsetIn(leaf, caret.node, caret.offset) }
}

/**
 * Block normalization and annotation.
 *
 * After sanitization the tree is reshaped so every text-bearing block is a leaf:
 *   - wrapper elements (div, section, …), and table parts outside a table, are unwrapped
 *   - inline elements that hold blocks are lifted out of the way
 *   - inline runs that sit next to block elements are wrapped in <p> (or <li> in lists)
 *   - two or more <br>s in a row end a paragraph
 *   - empty blocks are removed
 * Each leaf then gets a stable id (data-tb) derived from the hash of its tagged text.
 */
import render from 'dom-serializer'
import { type ChildNode, Document, Element, isTag, isText, type ParentNode, Text } from 'domhandler'
import { textContent } from 'domutils'
import { parseDocument } from 'htmlparser2'
import { blockHash, shortId } from './hash'
import {
  fromTaggedText,
  type InlineNode,
  type Placeholders,
  plainText,
  toTaggedText,
} from './tagged'

const UNWRAP = new Set(['div', 'section', 'article', 'aside', 'header', 'footer', 'main'])

/**
 * Table parts a browser's parser ignores outside a `<table>`. Readability leaves them behind when
 * it drops a layout table (paulgraham.com: `<tr><td>` and no table), and kept, the one row is the
 * article's only block. Outside a table they are unwrapped like the wrappers above.
 */
const TABLE_PARTS = new Set(['tbody', 'thead', 'tfoot', 'tr', 'td', 'th', 'caption'])

/**
 * Left where an unwrapped wrapper's inline content met inline content outside it, so the two are
 * wrapped as separate paragraphs, as a browser lays them out: `<div>One.</div><div>Two.</div>` was
 * one leaf reading "One.Two.". It counts as a block while the tree is normalized and is then removed.
 */
const BOUNDARY = 'tela-boundary'

/** Elements that can be leaf blocks when they contain only inline content. */
export const LEAF_TAGS = new Set([
  'p',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'li',
  'figcaption',
  'th',
  'td',
  'dt',
  'dd',
  'summary',
  'caption',
  'pre',
])

const BLOCK_LEVEL = new Set([
  ...LEAF_TAGS,
  'ul',
  'ol',
  'blockquote',
  'figure',
  'table',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'dl',
  'details',
  'hr',
  ...UNWRAP,
  BOUNDARY,
])

/** Blocks never sent to the translator. */
const SKIP_TAGS = new Set(['pre'])

export type BlockInfo = {
  id: string
  hash: string
  tag: string
  chars: number
  skip?: boolean
}

export type AnnotatedContent = {
  html: string
  blocks: BlockInfo[]
  /** Plain text of each translatable block, in document order. */
  texts: string[]
  /** Tagged text per block id (translatable blocks only). */
  tagged: Record<string, string>
}

function setChildren(parent: ParentNode, nodes: ChildNode[]) {
  parent.children = nodes
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i] as ChildNode
    node.parent = parent
    node.prev = nodes[i - 1] ?? null
    node.next = nodes[i + 1] ?? null
  }
}

function isBlockElement(node: ChildNode): node is Element {
  return isTag(node) && BLOCK_LEVEL.has(node.name)
}

function isMeaningfulInline(node: ChildNode): boolean {
  if (isText(node)) return /\S/.test(node.data)
  return isTag(node) && !BLOCK_LEVEL.has(node.name)
}

function isBlank(node: ChildNode): boolean {
  return isText(node) && !/\S/.test(node.data)
}

/**
 * Text, or an element holding text or a picture: what can run into a neighbour on screen. An empty
 * anchor (a heading's permalink) or a lone `<br>` cannot, and treating one as words made a heading
 * a container of paragraphs.
 */
function showsSomething(node: ChildNode): boolean {
  if (isText(node)) return /\S/.test(node.data)
  return isTag(node) && (node.name === 'img' || node.children.some(showsSomething))
}

/** The first block, or inline node that shows something: the neighbour words would run into. */
function firstSolid(nodes: ChildNode[]): ChildNode | undefined {
  return nodes.find((n) => isBlockElement(n) || showsSomething(n))
}

function lastSolid(nodes: ChildNode[]): ChildNode | undefined {
  return nodes.findLast((n) => isBlockElement(n) || showsSomething(n))
}

function touchesInline(a: ChildNode | undefined, b: ChildNode | undefined): boolean {
  return a !== undefined && b !== undefined && !isBlockElement(a) && !isBlockElement(b)
}

function unwrapAll(parent: ParentNode, inTable = false, inPre = false) {
  const next: ChildNode[] = []
  const children = parent.children
  for (let i = 0; i < children.length; i++) {
    const child = children[i] as ChildNode
    if (isTag(child)) {
      unwrapAll(child, inTable || child.name === 'table', inPre || child.name === 'pre')
      if (UNWRAP.has(child.name) || (!inTable && TABLE_PARTS.has(child.name))) {
        const inner = child.children
        // Inside a <pre> the text is literal, and a boundary would turn it into paragraphs.
        if (!inPre && touchesInline(lastSolid(next), firstSolid(inner))) next.push(boundary())
        next.push(...inner)
        if (!inPre && touchesInline(lastSolid(inner), firstSolid(children.slice(i + 1)))) {
          next.push(boundary())
        }
        continue
      }
    }
    next.push(child)
  }
  setChildren(parent, next)
}

function boundary(): Element {
  return new Element(BOUNDARY, {}, [])
}

function dropBoundaries(parent: ParentNode) {
  const next: ChildNode[] = []
  for (const child of parent.children) {
    if (isTag(child)) {
      if (child.name === BOUNDARY) continue
      dropBoundaries(child)
    }
    next.push(child)
  }
  setChildren(parent, next)
}

/**
 * An inline element that holds blocks (a `<span>` around every paragraph, an `<a>` around a card)
 * is a wrapper, not inline content. Left in place, the leaf around it holds every paragraph, and
 * tagged text keeps only their words: Paul Graham's essays reached the model as one run of text.
 * A bare `<span>` is unwrapped. Anything else is pushed down, a copy of it around each inline run
 * and each leaf's content, so a link, a language or a code span still covers what it covered.
 */
function liftInlineWrappers(parent: ParentNode) {
  const next: ChildNode[] = []
  for (const child of parent.children) {
    if (isTag(child) && child.name !== 'pre') {
      liftInlineWrappers(child)
      if (!BLOCK_LEVEL.has(child.name) && hasBlockChild(child)) {
        const bare = child.name === 'span' && Object.keys(child.attribs).length === 0
        next.push(...(bare ? child.children : spreadInto(child.children, child)))
        continue
      }
    }
    next.push(child)
  }
  setChildren(parent, next)
}

/** `nodes` with each meaningful inline run wrapped in a copy of `wrapper`, and each block reached. */
function spreadInto(nodes: ChildNode[], wrapper: Element): ChildNode[] {
  const out: ChildNode[] = []
  let run: ChildNode[] = []
  const flush = () => {
    if (run.some(isMeaningfulInline)) out.push(copyAround(wrapper, run))
    else out.push(...run)
    run = []
  }
  for (const node of nodes) {
    if (isBlockElement(node)) {
      flush()
      if (node.name !== 'pre' && node.children.length > 0) {
        setChildren(node, spreadInto(node.children, wrapper))
      }
      out.push(node)
    } else {
      run.push(node)
    }
  }
  flush()
  return out
}

function copyAround(wrapper: Element, nodes: ChildNode[]): Element {
  const copy = new Element(wrapper.name, { ...wrapper.attribs }, [])
  setChildren(copy, nodes)
  return copy
}

function wrapRuns(parent: ParentNode, wrapperTag: 'p' | 'li') {
  const out: ChildNode[] = []
  let run: ChildNode[] = []
  const flush = () => {
    if (run.some(isMeaningfulInline)) {
      const wrapper = new Element(wrapperTag, {}, [])
      setChildren(wrapper, run)
      out.push(wrapper)
    }
    run = []
  }
  for (const child of parent.children) {
    if (isBlockElement(child)) {
      flush()
      out.push(child)
    } else if (isText(child) && !/\S/.test(child.data) && run.length === 0) {
      // whitespace between blocks
    } else {
      run.push(child)
    }
  }
  flush()
  setChildren(parent, out)
}

function hasBlockChild(node: ParentNode): boolean {
  return node.children.some(isBlockElement)
}

function normalizeTree(parent: ParentNode) {
  const isDoc = parent instanceof Document
  const name = isDoc ? '' : (parent as Element).name
  const listLike = name === 'ul' || name === 'ol'
  const alwaysWrap = isDoc || name === 'blockquote' || name === 'figure' || name === 'details'
  if (listLike) {
    wrapRuns(parent, 'li')
  } else if (alwaysWrap || hasBlockChild(parent)) {
    wrapRuns(parent, 'p')
  }
  for (const child of [...parent.children]) {
    if (isTag(child)) normalizeTree(child)
  }
  // A <p> that ended up containing blocks is a wrapper, not a paragraph.
  if (name === 'p' && hasBlockChild(parent) && parent.parent) {
    const grand = parent.parent
    const idx = grand.children.indexOf(parent as ChildNode)
    const next = [...grand.children]
    next.splice(idx, 1, ...parent.children)
    setChildren(grand, next)
  }
}

function isBreak(node: ChildNode): boolean {
  return isTag(node) && node.name === 'br'
}

/**
 * Two or more `<br>`s in a row end a paragraph. An editor that never makes a `<p>` (Blogger,
 * Hatena) otherwise leaves a whole post in one leaf: one row beside its translation, and its
 * paragraphs kept only if the model leaves every `<xN/>` where it was. A single `<br>` stays, a
 * line break in a poem or an address, and so do breaks before the first words or after the last:
 * they separate nothing, and splitting on them would re-version every post that ends in a few.
 */
function splitOnBreaks(parent: ParentNode) {
  const next: ChildNode[] = []
  for (const child of parent.children) {
    if (isTag(child)) {
      if (child.name === 'p' && !hasBlockChild(child)) {
        next.push(...paragraphsOf(child))
        continue
      }
      if (child.name !== 'pre') splitOnBreaks(child)
    }
    next.push(child)
  }
  setChildren(parent, next)
}

/** What a paragraph needs to be one. */
function hasContent(nodes: ChildNode[]): boolean {
  return nodes.some(showsSomething)
}

function paragraphsOf(p: Element): ChildNode[] {
  const kids = p.children
  const segments: ChildNode[][] = [[]]
  let i = 0
  while (i < kids.length) {
    let j = i
    let breaks = 0
    while (j < kids.length && (isBreak(kids[j] as ChildNode) || isBlank(kids[j] as ChildNode))) {
      if (isBreak(kids[j] as ChildNode)) breaks += 1
      j += 1
    }
    const current = segments[segments.length - 1] as ChildNode[]
    if (breaks >= 2 && hasContent(current) && hasContent(kids.slice(j))) {
      segments.push([])
      i = j
    } else if (j > i) {
      current.push(...kids.slice(i, j))
      i = j
    } else {
      current.push(kids[i] as ChildNode)
      i += 1
    }
  }
  if (segments.length === 1) return [p]
  return segments.map((nodes) => copyAround(p, nodes))
}

function isEmptyBlock(el: Element): boolean {
  if (!LEAF_TAGS.has(el.name) || el.name === 'pre') return false
  if (/\S/.test(textContent(el))) return false
  const keeps = (n: ChildNode): boolean => isTag(n) && (n.name === 'img' || n.children.some(keeps))
  return !el.children.some(keeps)
}

function pruneEmpty(parent: ParentNode) {
  const next: ChildNode[] = []
  for (const child of parent.children) {
    if (isTag(child)) {
      pruneEmpty(child)
      if (isEmptyBlock(child)) continue
      if ((child.name === 'ul' || child.name === 'ol') && child.children.length === 0) continue
    }
    next.push(child)
  }
  setChildren(parent, next)
}

function toInline(nodes: ChildNode[]): InlineNode[] {
  const out: InlineNode[] = []
  for (const node of nodes) {
    if (isText(node)) out.push({ type: 'text', data: node.data })
    else if (isTag(node))
      out.push({
        type: 'tag',
        name: node.name,
        attribs: { ...node.attribs },
        children: toInline(node.children),
      })
  }
  return out
}

function isLeaf(el: Element): boolean {
  return LEAF_TAGS.has(el.name) && !hasBlockChild(el)
}

function collectLeaves(parent: ParentNode, out: Element[]) {
  for (const child of parent.children) {
    if (!isTag(child)) continue
    if (isLeaf(child)) out.push(child)
    else collectLeaves(child, out)
  }
}

/** Tagged text and placeholders for one leaf block. */
export function blockTaggedText(el: Element): { text: string; placeholders: Placeholders } {
  if (SKIP_TAGS.has(el.name)) return { text: textContent(el), placeholders: {} }
  return toTaggedText(toInline(el.children))
}

function isTranslatable(el: Element, plain: string): boolean {
  if (SKIP_TAGS.has(el.name)) return false
  if (plain.length < 2) return false
  return /\p{L}/u.test(plain)
}

/** Normalize sanitized HTML into leaf blocks and annotate each with a stable id. */
export async function annotateBlocks(sanitizedHtml: string): Promise<AnnotatedContent> {
  const doc = parseDocument(sanitizedHtml)
  unwrapAll(doc)
  liftInlineWrappers(doc)
  normalizeTree(doc)
  splitOnBreaks(doc)
  dropBoundaries(doc)
  pruneEmpty(doc)

  const leaves: Element[] = []
  collectLeaves(doc, leaves)

  const blocks: BlockInfo[] = []
  const texts: string[] = []
  const tagged: Record<string, string> = {}
  const seen = new Map<string, number>()

  for (const el of leaves) {
    const { text } = blockTaggedText(el)
    const plain = SKIP_TAGS.has(el.name) ? text.trim() : plainText(text)
    const hash = await blockHash(text)
    const base = shortId(hash)
    const n = (seen.get(base) ?? 0) + 1
    seen.set(base, n)
    const id = n === 1 ? base : `${base}-${n}`
    const skip = !isTranslatable(el, plain)
    el.attribs['data-tb'] = id
    if (skip) el.attribs['data-tb-skip'] = ''
    else delete el.attribs['data-tb-skip']
    const info: BlockInfo = { id, hash, tag: el.name, chars: plain.length }
    if (skip) info.skip = true
    blocks.push(info)
    if (!skip) {
      texts.push(plain)
      tagged[id] = text
    }
  }

  return { html: render(doc, { encodeEntities: 'utf8' }), blocks, texts, tagged }
}

/**
 * Replace the inner content of annotated blocks with translated tagged text.
 * Blocks without a translation keep their source content.
 */
export function rehydrateBlocks(annotatedHtml: string, translated: Record<string, string>): string {
  const doc = parseDocument(annotatedHtml)
  const leaves: Element[] = []
  collectLeaves(doc, leaves)
  for (const el of leaves) {
    const id = el.attribs['data-tb']
    if (!id || SKIP_TAGS.has(el.name)) continue
    const text = translated[id]
    if (text === undefined) continue
    const { placeholders } = blockTaggedText(el)
    const fragment = parseDocument(fromTaggedText(text, placeholders))
    setChildren(el, fragment.children)
  }
  return render(doc, { encodeEntities: 'utf8' })
}

/** Tagged text for every translatable block in already-annotated HTML, keyed by id. */
export function taggedTextsOf(annotatedHtml: string): Record<string, string> {
  const doc = parseDocument(annotatedHtml)
  const leaves: Element[] = []
  collectLeaves(doc, leaves)
  const out: Record<string, string> = {}
  for (const el of leaves) {
    const id = el.attribs['data-tb']
    if (!id || 'data-tb-skip' in el.attribs || SKIP_TAGS.has(el.name)) continue
    out[id] = blockTaggedText(el).text
  }
  return out
}

export { Text }

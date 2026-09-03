/**
 * Block normalization and annotation.
 *
 * After sanitization the tree is reshaped so every text-bearing block is a leaf:
 *   - wrapper elements (div, section, …) are unwrapped
 *   - inline runs that sit next to block elements are wrapped in <p> (or <li> in lists)
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

function unwrapAll(parent: ParentNode) {
  const next: ChildNode[] = []
  for (const child of parent.children) {
    if (isTag(child)) {
      unwrapAll(child)
      if (UNWRAP.has(child.name)) {
        next.push(...child.children)
        continue
      }
    }
    next.push(child)
  }
  setChildren(parent, next)
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
  normalizeTree(doc)
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

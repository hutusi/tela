/**
 * Split an article body into its top-level blocks, for the paired bilingual reader.
 *
 * The split is on the document's **top-level children**, never on `data-tb`. `LEAF_TAGS` includes
 * `li`, `td`, `th`, `dt` and `dd`, which are stamped inside `ul`/`table`/`dl`, so pairing at leaf
 * granularity would lift an `<li>` out of its list. A top-level child is the smallest unit that
 * survives being placed in a grid cell on its own.
 *
 * Pairing the two sides by index is sound because `rehydrateBlocks` builds the translated body
 * from the *same* annotated HTML and only replaces leaf children: both sides have the same
 * top-level elements, in the same order, with the same tags.
 */
import render from 'dom-serializer'
import { type ChildNode, isTag, isText, type ParentNode } from 'domhandler'
import { parseDocument } from 'htmlparser2'
import { rewriteImagesIn } from './images'

export type ArticleBlock = {
  /** Serialized HTML of one top-level child. */
  html: string
  /** Its tag name, or `#text` for a bare text run the normalizer left behind. */
  tag: string
  /** Every `data-tb` id inside it, in document order. Empty for an <hr> or an image-only <figure>. */
  ids: string[]
}

function collectIds(node: ChildNode, out: string[]): void {
  if (!isTag(node)) return
  const id = node.attribs['data-tb']
  if (id) out.push(id)
  for (const child of node.children) collectIds(child, out)
}

function blocksOf(doc: ParentNode): ArticleBlock[] {
  const out: ArticleBlock[] = []
  for (const child of doc.children) {
    if (isTag(child)) {
      const ids: string[] = []
      collectIds(child, ids)
      out.push({ html: render(child, { encodeEntities: 'utf8' }), tag: child.name, ids })
      continue
    }
    // A bare text run between blocks: rare, but dropping it would lose words.
    if (isText(child) && child.data.trim() !== '') {
      out.push({ html: render(child, { encodeEntities: 'utf8' }), tag: '#text', ids: [] })
    }
  }
  return out
}

/**
 * Article HTML as top-level blocks, image sources signed on the way when `sign` is given.
 *
 * Signing happens inside the one parse this does. Composing it as `split(await rewriteImages(…))`
 * would parse and serialize the whole body twice on a path ADR 0016 keeps to one database wave.
 */
export async function renderArticleBlocks(
  html: string,
  sign: ((url: string) => Promise<string>) | null,
): Promise<ArticleBlock[]> {
  if (!html) return []
  const doc = parseDocument(html)
  if (sign) await rewriteImagesIn(doc, sign)
  return blocksOf(doc)
}

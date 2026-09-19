import { type ArticleBlock, renderArticleBlocks, signImageUrl } from '@tela/content'
import type { ReaderBlock } from '@/components/reader-data'
import { imageProxySecret } from './platform/env'

/**
 * Article body as top-level blocks, ready to render: image sources go through the signed proxy
 * when configured.
 *
 * Returns the content package's own block, leaf ids and all, because deciding which blocks fell
 * back to their source text needs them. Only `readerBlocks` crosses the wire.
 */
export async function articleBlocks(html: string): Promise<ArticleBlock[]> {
  if (!html) return []
  const secret = await imageProxySecret()
  return renderArticleBlocks(html, secret ? (url) => signImageUrl(url, secret) : null)
}

/**
 * The part of a block the pane renders.
 *
 * A block's id is its first `data-tb`, or its position when it holds none. Positions are safe as
 * a fallback because the translated body is rehydrated from the same annotated HTML, so the two
 * sides always have the same elements in the same order.
 */
export function readerBlocks(blocks: readonly ArticleBlock[]): ReaderBlock[] {
  return blocks.map((block, i) => ({
    id: block.ids[0] ?? `#${i}`,
    tag: block.tag,
    html: block.html,
  }))
}

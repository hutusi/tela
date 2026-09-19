import { renderArticleBlocks, signImageUrl } from '@tela/content'
import type { ReaderBlock } from '@/components/reader-data'
import { imageProxySecret } from './platform/env'

/**
 * Article body as top-level blocks, ready to render: image sources go through the signed proxy
 * when configured.
 *
 * A block's id is its first `data-tb`, or its position when it holds none. Positions are safe as
 * a fallback because the translated body is rehydrated from the same annotated HTML, so the two
 * sides always have the same elements in the same order.
 */
export async function articleBlocks(html: string): Promise<ReaderBlock[]> {
  if (!html) return []
  const secret = await imageProxySecret()
  const blocks = await renderArticleBlocks(html, secret ? (url) => signImageUrl(url, secret) : null)
  return blocks.map((block, i) => ({
    id: block.ids[0] ?? `#${i}`,
    tag: block.tag,
    html: block.html,
  }))
}

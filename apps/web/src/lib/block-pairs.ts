import type { ReaderBlock } from '@/components/reader-data'

export type BlockPair = {
  /** React key and DOM hook: the block's id on both sides. */
  id: string
  /** The tag both sides share, or null for the whole-body fallback row. */
  tag: string | null
  translated: string
  original: string
}

function joined(blocks: readonly ReaderBlock[]): string {
  return blocks.map((block) => block.html).join('')
}

/**
 * One row per top-level block, translation first.
 *
 * Both bodies are rehydrated from the same annotated HTML, so block *i* is the same element on
 * both sides. When that stops being true the only safe answer is not to zip at all: a mis-zip
 * puts paragraph 12 beside paragraph 11 for the rest of the article, which is worse than not
 * pairing. The fallback is a single row holding both whole bodies — the layout this replaced —
 * and it needs no second code path downstream, because `tag: null` is also what tells the
 * renderer this row is not a block.
 */
export function pairBlocks(
  translated: readonly ReaderBlock[],
  original: readonly ReaderBlock[],
): BlockPair[] {
  const alignable =
    translated.length === original.length &&
    translated.every((block, i) => block.id === original[i]?.id && block.tag === original[i]?.tag)
  if (!alignable) {
    return [{ id: 'whole', tag: null, translated: joined(translated), original: joined(original) }]
  }
  return translated.map((block, i) => ({
    id: block.id,
    tag: block.tag,
    translated: block.html,
    original: original[i]?.html ?? '',
  }))
}

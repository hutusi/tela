import type { ArticleBlock } from '@tela/content'
import type { ReaderBlock } from '@/components/reader-data'

export type BlockPair = {
  /** React key and DOM hook: the block's id on both sides. */
  id: string
  /** The tag both sides share, or null for the whole-body fallback row. */
  tag: string | null
  translated: string
  original: string
  /** The translated side is source text: this block's translation failed or was capped. */
  untranslated: boolean
}

/**
 * Which top-level blocks contain a leaf the translator could not do.
 *
 * `failed_block_ids` names leaves, because that is the unit the translator works in, but the
 * reader marks what it can point at. One failed `<li>` therefore marks its whole list — the
 * alternative is marking inside the HTML string, which means parsing it again on the client.
 */
export function blocksContaining(
  blocks: readonly ArticleBlock[],
  leafIds: readonly string[],
): string[] {
  if (leafIds.length === 0) return []
  const failed = new Set(leafIds)
  const out: string[] = []
  blocks.forEach((block, i) => {
    if (block.ids.some((id) => failed.has(id))) out.push(block.ids[0] ?? `#${i}`)
  })
  return out
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
  untranslated: readonly string[] = [],
): BlockPair[] {
  const alignable =
    translated.length === original.length &&
    translated.every((block, i) => block.id === original[i]?.id && block.tag === original[i]?.tag)
  if (!alignable) {
    return [
      {
        id: 'whole',
        tag: null,
        translated: joined(translated),
        original: joined(original),
        untranslated: false,
      },
    ]
  }
  const failed = new Set(untranslated)
  return translated.map((block, i) => ({
    id: block.id,
    tag: block.tag,
    translated: block.html,
    original: original[i]?.html ?? '',
    untranslated: failed.has(block.id),
  }))
}

export type BlockRun = {
  /** React key: the first block of the run. */
  id: string
  html: string
  untranslated: boolean
}

/**
 * Consecutive blocks joined into runs by whether their translation fell back to source text.
 *
 * One column renders one `.article-body` per run instead of one for the whole body, so a fully
 * translated article is still a single body with a single measure and the rhythm it always had,
 * and only a partial one splits — exactly where there is something to say about it.
 */
export function runsOf(
  blocks: readonly ReaderBlock[],
  untranslated: readonly string[] = [],
): BlockRun[] {
  const failed = new Set(untranslated)
  const runs: BlockRun[] = []
  for (const block of blocks) {
    const flag = failed.has(block.id)
    const last = runs[runs.length - 1]
    if (last && last.untranslated === flag) last.html += block.html
    else runs.push({ id: block.id, html: block.html, untranslated: flag })
  }
  return runs
}

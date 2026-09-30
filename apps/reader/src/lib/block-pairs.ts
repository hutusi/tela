/**
 * Pairing a translation with its original, a top-level block at a time (ADR 0019). Content and
 * translation objects are aligned by block index by construction (ADR 0022), so pairing is
 * zipping; the checks below are for an object that is not what it says.
 */
import type { ContentObject } from '../store/objects'

/** One top-level block as the reader renders it. `id` is its first leaf, else its position. */
export type ReaderBlock = { id: string; tag: string; html: string }

export function readerBlocks(object: ContentObject): ReaderBlock[] {
  return object.blocks.map((b, i) => ({ id: b.leaves[0] ?? `#${i}`, tag: b.tag, html: b.html }))
}

/**
 * Which top-level blocks contain a leaf the translator could not do. The translator works in
 * leaves; the reader marks what it can point at, so one failed `<li>` marks its whole list.
 */
export function blocksContaining(object: ContentObject, leafIds: readonly string[]): string[] {
  if (leafIds.length === 0) return []
  const failed = new Set(leafIds)
  const out: string[] = []
  object.blocks.forEach((block, i) => {
    if (block.leaves.some((id) => failed.has(id))) out.push(block.leaves[0] ?? `#${i}`)
  })
  return out
}

export type BlockPair = {
  id: string
  /** The tag both sides share, or null for the whole-body fallback row. */
  tag: string | null
  translated: string
  original: string
  /** The translated side is source text: this block failed, or its chunk has not landed. */
  untranslated: boolean
  pending: boolean
}

/**
 * One row per top-level block, original and translation. A mismatch would put paragraph 12 beside
 * paragraph 11 for the rest of the article, so it falls back to one row holding both bodies.
 */
export function pairBlocks(
  translated: readonly (ReaderBlock | null)[],
  original: readonly ReaderBlock[],
  untranslated: readonly string[] = [],
): BlockPair[] {
  const alignable =
    translated.length === original.length &&
    translated.every(
      (b, i) => b === null || (b.id === original[i]?.id && b.tag === original[i]?.tag),
    )
  if (!alignable) {
    return [
      {
        id: 'whole',
        tag: null,
        translated: translated.map((b) => b?.html ?? '').join(''),
        original: original.map((b) => b.html).join(''),
        untranslated: false,
        pending: false,
      },
    ]
  }
  const failed = new Set(untranslated)
  return original.map((o, i) => {
    const t = translated[i] ?? null
    return {
      id: o.id,
      tag: o.tag,
      translated: t?.html ?? o.html,
      original: o.html,
      untranslated: t === null || failed.has(o.id),
      pending: t === null,
    }
  })
}

export type BlockRun = { id: string; html: string; untranslated: boolean; pending: boolean }

/**
 * Consecutive blocks joined into runs by whether they fell back to source text, so one column is
 * a single `.article-body` unless the translation is partial or still arriving.
 */
export function runsOf(pairs: readonly BlockPair[], side: 'translated' | 'original'): BlockRun[] {
  const runs: BlockRun[] = []
  for (const p of pairs) {
    const flag = side === 'translated' && p.untranslated
    const pending = side === 'translated' && p.pending
    const html = side === 'translated' ? p.translated : p.original
    const last = runs[runs.length - 1]
    if (last && last.untranslated === flag && last.pending === pending) last.html += html
    else runs.push({ id: p.id, html, untranslated: flag, pending })
  }
  return runs
}

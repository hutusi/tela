/**
 * An open article's highlights (ADR 0026): found again in what the page renders, painted, and
 * re-anchored when the post has changed under them.
 *
 * - Each side resolves against its own rendered leaves: the original's column, and the
 *   translation's once it has finished (a streaming translation's text is still changing, so it
 *   would move or detach highlights that are fine).
 * - A highlight the post moved is written back with its new anchor and the current content key,
 *   once, so every device finds it where this one did.
 * - A side the layout does not show (the translation in "original" mode) is `elsewhere`, not
 *   detached: nothing is known about it until it is rendered.
 */
import type { ArticleRow, HighlightRow } from '@tela/sync'
import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useStore, useTables } from '../store/hooks'
import { anchorChanged, anchorIn, type Resolved, resolveAnchor } from './anchor'
import { paint, rangeIn, renderedLeaves, type Side, textsOf, unpaint } from './highlight-dom'

export type HighlightStatus = 'shown' | 'detached' | 'elsewhere'
export type HighlightItem = { row: HighlightRow; status: HighlightStatus; leaf: HTMLElement | null }

type Options = {
  article: ArticleRow
  root: React.RefObject<HTMLElement | null>
  readingLang: string
  /** Anything whose change means the body was rendered again (mode, content, translation). */
  rendered: unknown
  translationSettled: boolean
  activeId: string | null
}

export function useHighlights({
  article,
  root,
  readingLang,
  rendered,
  translationSettled,
  activeId,
}: Options) {
  const tables = useTables()
  const { store } = useStore()
  const rows = useMemo(
    () =>
      [...tables.highlights.values()]
        .filter((h) => h.articleId === article.id)
        .sort((a, b) => a.createdAt - b.createdAt),
    [tables.highlights, article.id],
  )
  const [items, setItems] = useState<HighlightItem[]>([])
  /** Anchors already written back from this device, so a rewrite is sent once. */
  const rewritten = useRef(new Set<string>())

  // biome-ignore lint/correctness/useExhaustiveDependencies: `rendered` stands for the body's DOM
  useLayoutEffect(() => {
    const el = root.current
    if (!el) return
    const leavesOf = new Map<Side, Map<string, HTMLElement>>([
      ['original', renderedLeaves(el, 'original')],
      ['translation', translationSettled ? renderedLeaves(el, 'translation') : new Map()],
    ])
    const textsFor = new Map([...leavesOf].map(([side, leaves]) => [side, textsOf(leaves)]))
    const next: HighlightItem[] = []
    const ranges: Range[] = []
    const active: Range[] = []
    for (const row of rows) {
      const side = row.side
      const leaves = leavesOf.get(side) ?? new Map()
      const texts = textsFor.get(side) ?? new Map()
      if (leaves.size === 0 || (side === 'translation' && row.lang !== readingLang)) {
        next.push({ row, status: 'elsewhere', leaf: null })
        continue
      }
      const resolved: Resolved = resolveAnchor(row, texts)
      if (resolved.status === 'detached') {
        next.push({ row, status: 'detached', leaf: null })
        continue
      }
      const leaf = leaves.get(resolved.leafId) ?? null
      const range = leaf ? rangeIn(leaf, resolved.start, resolved.end) : null
      if (range) (row.id === activeId ? active : ranges).push(range)
      next.push({ row, status: 'shown', leaf })
      // Written back once: the moved anchor, or an unchanged one now on the current version.
      const stale = anchorChanged(row, resolved) || row.contentKey !== article.contentKey
      const key = `${row.id}:${resolved.leafId}:${resolved.start}:${article.contentKey}`
      if (stale && article.contentKey && !rewritten.current.has(key)) {
        rewritten.current.add(key)
        const text = texts.get(resolved.leafId) ?? ''
        store.mutate({
          type: 'putHighlight',
          id: row.id,
          articleId: row.articleId,
          contentKey: article.contentKey,
          side,
          lang: row.lang,
          ...anchorIn(resolved.leafId, text, resolved.start, resolved.end),
          note: row.note,
        })
      }
    }
    paint(ranges, active)
    // Only a real change renders again: this runs after every render of the body.
    setItems((held) =>
      held.length === next.length &&
      held.every(
        (h, i) =>
          h.row === next[i]?.row && h.status === next[i]?.status && h.leaf === next[i]?.leaf,
      )
        ? held
        : next,
    )
  }, [rows, rendered, translationSettled, readingLang, activeId, article.contentKey, store, root])

  useLayoutEffect(() => unpaint, [])

  /** The highlight a click at this leaf offset landed on, on the side it landed. */
  const at = (side: Side, leafId: string, offset: number): HighlightRow | undefined =>
    items.find(
      (item) =>
        item.status === 'shown' &&
        item.row.side === side &&
        item.leaf?.getAttribute('data-tb') === leafId &&
        (() => {
          const found = resolveAnchor(item.row, new Map([[leafId, item.leaf?.textContent ?? '']]))
          return found.status !== 'detached' && found.start <= offset && offset <= found.end
        })(),
    )?.row

  return { items, at }
}

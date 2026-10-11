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
 * - They are listed in reading order: by the post's leaves, then where each starts in its leaf.
 *   The original and its translation share leaf ids, so one order serves both sides.
 */
import type { ArticleRow, HighlightRow } from '@tela/sync'
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useStore, useTables } from '../store/hooks'
import { anchorChanged, anchorIn, type Resolved, resolveAnchor } from './anchor'
import { paint, rangeIn, renderedLeaves, type Side, textsOf, unpaint } from './highlight-dom'

export type HighlightStatus = 'shown' | 'detached' | 'elsewhere'
/**
 * A highlight as this render found it. `leafId`, `start` and `end` are where it resolved to in the
 * text on the page when `shown`, and its stored anchor otherwise.
 */
export type HighlightItem = {
  row: HighlightRow
  status: HighlightStatus
  leaf: HTMLElement | null
  leafId: string
  start: number
  end: number
}

type Options = {
  article: ArticleRow
  root: React.RefObject<HTMLElement | null>
  readingLang: string
  /** Each leaf id's place in the post (the content object's leaves, in order): the list's order. */
  order: ReadonlyMap<string, number>
  /** Anything whose change means the body was rendered again (mode, content, translation). */
  rendered: unknown
  translationSettled: boolean
  activeId: string | null
}

export function useHighlights({
  article,
  root,
  readingLang,
  order,
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
  /** The items as the page is now, for a handler that runs between renders. */
  const current = useRef<HighlightItem[]>([])
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
      const stored = { leafId: row.leafId, start: row.start, end: row.end }
      if (leaves.size === 0 || (side === 'translation' && row.lang !== readingLang)) {
        next.push({ row, status: 'elsewhere', leaf: null, ...stored })
        continue
      }
      const resolved: Resolved = resolveAnchor(row, texts)
      if (resolved.status === 'detached') {
        next.push({ row, status: 'detached', leaf: null, ...stored })
        continue
      }
      const { leafId, start, end } = resolved
      const leaf = leaves.get(leafId) ?? null
      const range = leaf ? rangeIn(leaf, start, end) : null
      if (range) (row.id === activeId ? active : ranges).push(range)
      next.push({ row, status: 'shown', leaf, leafId, start, end })
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
    // Reading order; a passage the post no longer has goes last. `rows` came oldest first, and the
    // sort is stable, so two at the same place keep the order they were made in.
    const place = (item: HighlightItem) => order.get(item.leafId) ?? Number.MAX_SAFE_INTEGER
    next.sort(
      (a, b) =>
        Number(a.status === 'detached') - Number(b.status === 'detached') ||
        place(a) - place(b) ||
        a.start - b.start,
    )
    current.current = next
    // Only a real change renders again: this runs after every render of the body.
    setItems((held) =>
      held.length === next.length &&
      held.every((h, i) => {
        const n = next[i]
        return (
          h.row === n?.row &&
          h.status === n.status &&
          h.leaf === n.leaf &&
          h.leafId === n.leafId &&
          h.start === n.start &&
          h.end === n.end
        )
      })
        ? held
        : next,
    )
  }, [
    rows,
    order,
    rendered,
    translationSettled,
    readingLang,
    activeId,
    article.contentKey,
    store,
    root,
  ])

  useLayoutEffect(() => unpaint, [])

  /** The highlight a click at this leaf offset landed on, on the side it landed. */
  const at = useCallback(
    (side: Side, leafId: string, offset: number): HighlightRow | undefined =>
      current.current.find(
        (item) =>
          item.status === 'shown' &&
          item.row.side === side &&
          item.leafId === leafId &&
          item.start <= offset &&
          offset <= item.end,
      )?.row,
    [],
  )

  /**
   * The highlights painted in one leaf of one side (and, on the translation, in the language it
   * is in), where they are on the page now: what a new highlight there merges with.
   */
  const inLeaf = useCallback(
    (side: Side, lang: string | null, leafId: string): HighlightItem[] =>
      current.current.filter(
        (item) =>
          item.status === 'shown' &&
          item.row.side === side &&
          (side === 'original' || item.row.lang === lang) &&
          item.leafId === leafId,
      ),
    [],
  )

  return { items, at, inLeaf }
}

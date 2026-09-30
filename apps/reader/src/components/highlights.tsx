/**
 * Making, annotating and listing highlights (ADR 0026). Private to the member; synced like their
 * likes. The painting itself is `lib/use-highlights.ts`: nothing here touches the article's DOM.
 */
import { HIGHLIGHT_NOTE_MAX } from '@tela/shared'
import type { HighlightRow } from '@tela/sync'
import { useEffect, useRef, useState } from 'react'
import { useTranslations } from 'use-intl'
import type { Anchor } from '../lib/anchor'
import { type Side, selectedAnchor } from '../lib/highlight-dom'
import type { HighlightItem } from '../lib/use-highlights'
import { useStore } from '../store/hooks'

export type Selected = { side: Side; anchor: Anchor; rect: DOMRect }

/** The reader's current selection inside `root`, as an anchor, following it as it changes. */
export function useSelectedAnchor(root: React.RefObject<HTMLElement | null>): Selected | null {
  const [selected, setSelected] = useState<Selected | null>(null)
  useEffect(() => {
    let frame = 0
    const update = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() =>
        setSelected(root.current ? selectedAnchor(root.current) : null),
      )
    }
    document.addEventListener('selectionchange', update)
    window.addEventListener('scroll', update, true)
    window.addEventListener('resize', update)
    return () => {
      cancelAnimationFrame(frame)
      document.removeEventListener('selectionchange', update)
      window.removeEventListener('scroll', update, true)
      window.removeEventListener('resize', update)
    }
  }, [root])
  return selected
}

/** Floats above the selection: highlight it, or highlight it and write a note. */
export function HighlightToolbar({
  selected,
  onHighlight,
}: {
  selected: Selected
  onHighlight: (withNote: boolean) => void
}) {
  const t = useTranslations('highlights')
  const { rect } = selected
  const top = rect.top > 56 ? rect.top - 44 : rect.bottom + 8
  const left = Math.min(Math.max(rect.left + rect.width / 2, 90), window.innerWidth - 90)
  // mousedown would collapse the selection before the click could use it.
  const keep = (e: React.MouseEvent) => e.preventDefault()
  return (
    <div
      className="fixed z-20 flex -translate-x-1/2 items-center gap-0.5 rounded-full border border-line bg-surface p-1 text-[13px] shadow-[0_8px_24px_rgba(0,0,0,.12)]"
      style={{ top, left }}
      data-testid="highlight-toolbar"
    >
      <button
        type="button"
        onMouseDown={keep}
        onClick={() => onHighlight(false)}
        className="rounded-full px-3 py-1.5 font-medium text-ink hover:bg-hover"
        data-testid="highlight-create"
      >
        <span
          aria-hidden="true"
          className="mr-1.5 inline-block size-2.5 rounded-sm bg-highlight align-middle"
        />
        {t('highlight')}
      </button>
      <button
        type="button"
        onMouseDown={keep}
        onClick={() => onHighlight(true)}
        className="rounded-full px-3 py-1.5 text-ink-2 hover:bg-hover hover:text-ink"
        data-testid="highlight-create-note"
      >
        {t('addNote')}
      </button>
    </div>
  )
}

/** A highlight's note, and the way to remove it, next to where it was clicked. */
export function HighlightNote({
  row,
  at,
  onClose,
}: {
  row: HighlightRow
  at: { x: number; y: number }
  onClose: () => void
}) {
  const t = useTranslations('highlights')
  const { store } = useStore()
  const [note, setNote] = useState(row.note ?? '')
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    box.current?.querySelector('textarea')?.focus()
    const outside = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', outside)
    return () => document.removeEventListener('mousedown', outside)
  }, [onClose])

  const save = () => {
    const { id, articleId, contentKey, side, lang, leafId, start, end, quote, prefix, suffix } = row
    store.mutate({
      type: 'putHighlight',
      ...{ id, articleId, contentKey, side, lang, leafId, start, end, quote, prefix, suffix },
      note: note.trim() || null,
    })
    onClose()
  }
  const remove = () => {
    store.mutate({ type: 'deleteHighlight', id: row.id })
    onClose()
  }
  const top = Math.min(at.y + 12, window.innerHeight - 240)
  const left = Math.min(Math.max(at.x - 160, 12), window.innerWidth - 332)

  return (
    <div
      ref={box}
      role="dialog"
      aria-label={t('noteLabel')}
      className="fixed z-20 flex w-80 flex-col gap-2.5 rounded-xl border border-line bg-surface p-3.5 shadow-[0_12px_32px_rgba(0,0,0,.14)] animate-fade"
      style={{ top, left }}
      data-testid="highlight-note"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault()
          onClose()
        }
      }}
    >
      <blockquote className="m-0 line-clamp-3 border-l-2 border-highlight-strong pl-2.5 font-serif text-[15px] italic leading-snug text-ink-2">
        {row.quote}
      </blockquote>
      <textarea
        value={note}
        onChange={(e) => setNote(e.target.value.slice(0, HIGHLIGHT_NOTE_MAX))}
        placeholder={t('notePlaceholder')}
        rows={3}
        data-testid="highlight-note-text"
        className="w-full resize-none rounded-lg border border-line bg-paper px-3 py-2.5 font-serif text-base leading-[1.4] text-ink outline-none focus:border-muted"
      />
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={remove}
          className="flex-1 text-left text-[13px] text-muted hover:text-danger"
          data-testid="highlight-remove"
        >
          {t('remove')}
        </button>
        <button
          type="button"
          onClick={onClose}
          className="rounded-md px-2.5 py-1.5 text-muted hover:bg-hover hover:text-ink"
        >
          {t('cancel')}
        </button>
        <button
          type="button"
          onClick={save}
          data-testid="highlight-note-save"
          className="rounded-full bg-ink px-3.5 py-[7px] font-medium text-paper hover:brightness-125"
        >
          {t('save')}
        </button>
      </div>
    </div>
  )
}

/**
 * Every highlight of this post, in the order they were made. One the post no longer contains
 * keeps its quote and note and says so; one on a layout not showing says where it is.
 */
export function HighlightList({
  items,
  onOpen,
}: {
  items: HighlightItem[]
  onOpen: (item: HighlightItem, at: { x: number; y: number }) => void
}) {
  const t = useTranslations('highlights')
  const { store } = useStore()
  if (items.length === 0) return null
  return (
    <section className="mt-12 max-w-(--reader-measure)" data-testid="highlights">
      <h2 className="mb-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">
        {t('title', { n: items.length })}
      </h2>
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {items.map((item) => (
          <li
            key={item.row.id}
            className="rounded-xl border border-line bg-surface px-4 py-3"
            data-testid="highlight-item"
            data-status={item.status}
          >
            <button
              type="button"
              disabled={item.status !== 'shown'}
              onClick={(e) => {
                item.leaf?.scrollIntoView({ block: 'center', behavior: 'smooth' })
                onOpen(item, { x: e.clientX, y: e.clientY })
              }}
              className="w-full text-left disabled:cursor-default"
            >
              <span className="block font-serif text-[16px] leading-snug text-body">
                <mark className="rounded-sm bg-highlight px-0.5 text-inherit">
                  {item.row.quote}
                </mark>
              </span>
              {item.row.note ? (
                <span className="mt-1.5 block text-[13.5px] leading-snug text-ink-2">
                  {item.row.note}
                </span>
              ) : null}
            </button>
            {item.status !== 'shown' ? (
              <div className="mt-2 flex items-center gap-3 text-[12px] text-muted">
                <span className="flex-1">
                  {item.status === 'detached' ? t('detached') : t('elsewhere')}
                </span>
                {item.status === 'detached' ? (
                  <button
                    type="button"
                    className="hover:text-danger"
                    onClick={() => store.mutate({ type: 'deleteHighlight', id: item.row.id })}
                  >
                    {t('remove')}
                  </button>
                ) : null}
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  )
}

/**
 * Making, annotating and listing highlights (ADR 0026). Private to the member; synced like their
 * likes. The painting itself is `lib/use-highlights.ts`: nothing here touches the article's DOM.
 */
import { HIGHLIGHT_NOTE_MAX } from '@tela/shared'
import type { HighlightRow } from '@tela/sync'
import {
  type CSSProperties,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
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

/**
 * A finger, or a pane below Tailwind's `lg`: the toolbar goes under the selection, where the
 * system's own selection menu (above it, on phones) leaves it alone.
 */
const UNDER = '(pointer: coarse), (width < 64rem)'

function useUnder(): boolean {
  return useSyncExternalStore(
    (changed) => {
      const query = window.matchMedia(UNDER)
      query.addEventListener('change', changed)
      return () => query.removeEventListener('change', changed)
    },
    () => window.matchMedia(UNDER).matches,
    () => false,
  )
}

/** The sticky header's height: the toolbar never sits under it. */
const HEADER = 56
/** Between the toolbar and the selection, and between it and the window's edges. */
const GAP = 8

/**
 * Over the selection, following it as it scrolls: highlight it, or highlight it and write a note.
 * Centred 8px above it, or under it where there is no room above or on a phone; kept inside the
 * window, and above the phone reader's bottom bar (`--bottom-bar`).
 */
export function HighlightToolbar({
  selected,
  onHighlight,
}: {
  selected: Selected
  onHighlight: (withNote: boolean) => void
}) {
  const t = useTranslations('highlights')
  const under = useUnder()
  // Its own size places it: measured before it is painted, and again whenever it changes.
  const box = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const { offsetWidth: width, offsetHeight: height } = el
    setSize((held) => (held.width === width && held.height === height ? held : { width, height }))
  })
  const { rect } = selected
  const half = size.width / 2
  const left = Math.min(
    Math.max(rect.left + rect.width / 2, half + GAP),
    window.innerWidth - half - GAP,
  )
  const above = !under && rect.top - GAP - size.height >= HEADER
  const style: CSSProperties = above
    ? { left, top: rect.top, transform: `translate(-50%, calc(-100% - ${GAP}px))` }
    : {
        left,
        top: `max(${HEADER + GAP}px, min(${rect.bottom + GAP}px, calc(100dvh - var(--bottom-bar, 0px) - ${size.height + GAP}px)))`,
        transform: 'translateX(-50%)',
      }
  // mousedown would collapse the selection before the click could use it.
  const keep = (e: React.MouseEvent) => e.preventDefault()
  const button = `flex cursor-pointer items-center whitespace-nowrap font-medium text-on-primary hover:bg-on-primary/14 ${
    under
      ? 'min-h-10 gap-2 rounded-lg px-3.5 text-sm'
      : 'gap-1.5 rounded-md px-2.5 py-1.5 text-[13px]'
  }`
  return (
    <div
      ref={box}
      className={`fixed z-20 flex gap-0.5 bg-ink p-1 shadow-[0_8px_24px_rgba(0,0,0,.18)] ${
        under ? 'rounded-xl' : 'rounded-[10px]'
      }`}
      style={style}
      data-testid="highlight-toolbar"
      data-place={above ? 'above' : 'under'}
    >
      <button
        type="button"
        onMouseDown={keep}
        onClick={() => onHighlight(false)}
        aria-keyshortcuts="h"
        className={button}
        data-testid="highlight-create"
      >
        <span aria-hidden="true" className="size-3 shrink-0 rounded-[3px] bg-highlight" />
        {t('highlight')}
        {/* No key to press on a phone. */}
        <kbd className="rounded-[4px] border border-on-primary/35 px-1 font-sans text-[10.5px] leading-[14px] opacity-75 pointer-coarse:hidden">
          H
        </kbd>
      </button>
      <button
        type="button"
        onMouseDown={keep}
        onClick={() => onHighlight(true)}
        className={button}
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
 * Every highlight of this post, in reading order (`useHighlights`). One the post no longer
 * contains keeps its quote and note, says so and comes last; one on a layout not showing says
 * where it is.
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
    <section className="mt-9 max-w-(--reader-measure)" data-testid="highlights">
      <h2 className="mb-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">
        {t('title', { n: items.length })}
      </h2>
      <ul className="m-0 list-none p-0">
        {items.map((item) => (
          <li
            key={item.row.id}
            className="border-t border-line"
            data-testid="highlight-item"
            data-status={item.status}
          >
            <button
              type="button"
              disabled={item.status !== 'shown'}
              onClick={(e) => {
                item.leaf?.scrollIntoView({ block: 'center', behavior: 'smooth' })
                // From the keyboard there is no pointer: the note opens by the row instead.
                const row = e.currentTarget.getBoundingClientRect()
                onOpen(item, { x: e.clientX || row.left + 40, y: e.clientY || row.bottom })
              }}
              className="flex w-full flex-col gap-1.5 py-3.5 text-left disabled:cursor-default"
            >
              <span className="font-serif text-[17px] leading-normal text-ink">
                <mark className="rounded-[2px] bg-highlight text-inherit box-decoration-clone">
                  {item.row.quote}
                </mark>
              </span>
              {item.row.note ? (
                <span className="whitespace-pre-line text-[13.5px] leading-[1.45] text-ink-2">
                  {item.row.note}
                </span>
              ) : item.status === 'shown' ? (
                <span className="text-[13px] text-muted">{t('addNote')}</span>
              ) : null}
            </button>
            {item.status !== 'shown' ? (
              <div className="-mt-1.5 flex items-center gap-3 pb-3.5 text-[12px] text-muted">
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
      <p className="m-0 border-t border-line pt-3 text-[12.5px] text-muted">
        {t.rich('privacy', {
          keyboard: (chunks) => <span className="pointer-coarse:hidden">{chunks}</span>,
        })}
      </p>
    </section>
  )
}

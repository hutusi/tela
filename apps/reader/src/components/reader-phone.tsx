/**
 * The article on a phone (below `lg`; Tela Mobile 03–05): a back bar above it in place of the
 * toolbar, a bar of its actions fixed under it where a thumb reaches, and Recommend as a bottom
 * sheet. The Reader renders these instead of the desktop controls rather than beside them hidden,
 * so each control, and its test id, exists once.
 */
import { type RefObject, useEffect, useId, useLayoutEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useTranslations } from 'use-intl'
import { BACK, CHECK, EXTERNAL, Glyph, HEART, HEART_FILLED, PASS } from './glyph'
import { RecommendForm } from './recommend-popover'
import { TypographyMenu } from './typography-menu'

/** An open circle: the unread dot, to put back. Drawn as the other glyphs are. */
const UNREAD = <circle cx="8" cy="8" r="4.25" />

/** "‹ All articles" back to the list the article was opened from, and Aa. */
export function ReaderBackBar({ listName, onBack }: { listName: string; onBack: () => void }) {
  const t = useTranslations('reader')
  return (
    <div
      className="-mx-5 -mt-6 mb-5 flex h-[52px] items-center gap-2 border-b border-line pl-1 pr-2 md:-mx-8"
      data-testid="back-bar"
    >
      <button
        type="button"
        onClick={onBack}
        aria-label={t('backTo', { list: listName })}
        className="flex h-11 min-w-0 items-center gap-0.5 rounded-md px-2.5 text-ink-2 hover:bg-hover hover:text-ink"
        data-testid="reader-back"
      >
        <Glyph className="shrink-0">{BACK}</Glyph>
        <span className="truncate">{listName}</span>
      </button>
      <div className="flex-1" />
      <TypographyMenu />
    </div>
  )
}

const ITEM =
  'flex min-h-12 flex-col items-center justify-center gap-[3px] rounded-lg text-[11.5px] hover:bg-hover hover:text-ink hover:no-underline'

/**
 * Like, Recommend, Mark read and the original, fixed at the foot of the screen. While it shows,
 * `--bottom-bar` on the root says how tall it is, so the toast and the end of the article clear it.
 * It is put in the body, not the reader pane: the pane fades in on a transform, and a transformed
 * ancestor would hold a `fixed` bar to the pane, and clip it, while it does.
 */
export function ReaderBottomBar({
  liked,
  likeCount,
  onLike,
  recommended,
  onRecommend,
  recommendRef,
  read,
  onRead,
  url,
}: {
  liked: boolean
  likeCount: number
  onLike: () => void
  recommended: boolean
  onRecommend: () => void
  /** Where focus goes back to when the sheet this opens closes. */
  recommendRef: RefObject<HTMLButtonElement | null>
  read: boolean
  onRead: () => void
  url: string | null
}) {
  const t = useTranslations('reader')
  const bar = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const el = bar.current
    if (!el) return
    const root = document.documentElement
    const measure = () => root.style.setProperty('--bottom-bar', `${el.offsetHeight}px`)
    measure()
    // The safe area, and so the bar's padding, changes as the phone turns.
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => {
      observer.disconnect()
      root.style.removeProperty('--bottom-bar')
    }
  }, [])
  const on = (active: boolean) => (active ? 'font-medium text-ink' : 'text-ink-2')
  return createPortal(
    <div
      ref={bar}
      className="fixed inset-x-0 bottom-0 z-20 grid grid-cols-4 border-t border-line bg-paper px-1.5 pb-[max(22px,env(safe-area-inset-bottom))] pt-1.5"
      data-testid="bottom-bar"
    >
      <button
        type="button"
        aria-pressed={liked}
        onClick={onLike}
        className={`${ITEM} ${on(liked)}`}
        data-testid="bar-like"
      >
        <Glyph size={20} strokeWidth={1.3}>
          {liked ? HEART_FILLED : HEART}
        </Glyph>
        {t(liked ? 'likedCount' : 'likeCount', { n: likeCount })}
      </button>
      <button
        ref={recommendRef}
        type="button"
        aria-pressed={recommended}
        onClick={onRecommend}
        className={`${ITEM} ${on(recommended)}`}
        data-testid="bar-recommend"
      >
        <Glyph size={20} strokeWidth={1.3}>
          {PASS}
        </Glyph>
        {recommended ? t('recommendedLabel') : t('recommend')}
      </button>
      {/* As the toolbar's button on a desktop: the label says what it does, and does it. */}
      <button
        type="button"
        onClick={onRead}
        className={`${ITEM} text-ink-2`}
        data-testid={read ? 'mark-unread' : 'mark-read'}
      >
        <Glyph size={20} strokeWidth={1.3}>
          {read ? UNREAD : CHECK}
        </Glyph>
        {t(read ? 'markUnreadShort' : 'markReadShort')}
      </button>
      {url ? (
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className={`${ITEM} text-ink-2`}
          data-testid="bar-original"
        >
          <Glyph size={20} strokeWidth={1.3}>
            {EXTERNAL}
          </Glyph>
          {t('original')}
        </a>
      ) : null}
    </div>,
    document.body,
  )
}

/**
 * Recommend as a bottom sheet: a modal dialog, so the page under it is out of reach and Tab stays
 * in it, with the scrim under it (`dialog.sheet::backdrop`, styles.css). Esc, Cancel and a tap on
 * the scrim close it, and focus goes back to the button that opened it.
 */
export function RecommendSheet({
  articleId,
  note,
  post,
  opener,
  onClose,
}: {
  articleId: number
  note: string | null
  /** "{title} · {blog}", under the sheet's title. */
  post: string
  opener: RefObject<HTMLElement | null>
  onClose: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  useEffect(() => {
    const el = dialog.current
    const back = opener.current
    // Once: React may run this twice in development, and an open dialog refuses a second.
    if (el && !el.open) el.showModal()
    return () => {
      el?.close()
      back?.focus()
    }
  }, [opener])
  return (
    <dialog
      ref={dialog}
      aria-labelledby={titleId}
      // A close request with no key, such as Android's back gesture.
      onCancel={(e) => {
        e.preventDefault()
        onClose()
      }}
      // Esc is taken here, wherever focus is in the sheet, and marked handled, so the reader's
      // own Esc does not close the article under it.
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault()
          onClose()
        }
      }}
      // The dialog is its content's box, so a click on the dialog itself is one on the scrim.
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
      className="sheet mx-0 mb-0 mt-auto max-h-[calc(100dvh-24px)] w-full max-w-none overflow-y-auto rounded-t-[18px] border-0 bg-surface p-0 text-ink shadow-[0_-8px_30px_rgba(0,0,0,.12)] animate-fade"
      data-testid="recommend-sheet"
    >
      <div className="flex flex-col gap-3.5 px-5 pb-[max(30px,env(safe-area-inset-bottom))] pt-2.5">
        <span aria-hidden="true" className="h-1 w-9 self-center rounded-sm bg-thumb" />
        <RecommendForm
          articleId={articleId}
          note={note}
          onClose={onClose}
          sheet={{ titleId, post }}
        />
      </div>
    </dialog>
  )
}

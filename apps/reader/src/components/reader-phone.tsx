/**
 * The article on a phone (below `lg`; Tela Mobile 03–05): a back bar above it in place of the
 * toolbar, a bar of its actions fixed under it where a thumb reaches, and Recommend as a bottom
 * sheet. The Reader renders these instead of the desktop controls rather than beside them hidden,
 * so each control, and its test id, exists once.
 */
import { type RefObject, useId, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useTranslations } from 'use-intl'
import { useBottomBar } from '../lib/use-bottom-bar'
import { BACK, CHECK, EXTERNAL, Glyph, HEART, HEART_FILLED, PASS } from './glyph'
import { RecommendForm } from './recommend-popover'
import { Sheet } from './sheet'
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
 *
 * It sits under the sticky header (`z-[9]` to its `z-10`). The account menu opens inside the
 * header's stacking context, so a bar above the header covered the menu's last rows, and a tap on
 * Sign out marked the post read. What floats over the page from the body (the highlight toolbar
 * and note, the toast) is above both.
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
  useBottomBar(bar)
  const on = (active: boolean) => (active ? 'font-medium text-ink' : 'text-ink-2')
  // A post with no address of its own has no Original: three items share the width.
  return createPortal(
    <div
      ref={bar}
      className={`fixed inset-x-0 bottom-0 z-[9] grid ${url ? 'grid-cols-4' : 'grid-cols-3'} border-t border-line bg-paper px-1.5 pb-[max(22px,env(safe-area-inset-bottom))] pt-1.5`}
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
 * Recommend as a bottom sheet (`Sheet`): Esc, Cancel and a tap on the scrim close it, and focus
 * goes back to the button that opened it.
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
  const titleId = useId()
  return (
    <Sheet labelledBy={titleId} opener={opener} onClose={onClose} testId="recommend-sheet">
      <RecommendForm
        articleId={articleId}
        note={note}
        onClose={onClose}
        sheet={{ titleId, post }}
      />
    </Sheet>
  )
}

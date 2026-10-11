import { RECOMMENDATION_NOTE_MAX } from '@tela/shared'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslations } from 'use-intl'
import { showToast } from '../lib/toasts'
import { useStore } from '../store/hooks'
import { Glyph, PASS } from './glyph'

/** Takes a recommendation back: applied here at once and synced behind it (ADR 0025), and said. */
export function useUnrecommend(): (articleId: number) => void {
  const t = useTranslations('reader')
  const { store } = useStore()
  return useCallback(
    (articleId: number) => {
      store.mutate({ type: 'unrecommend', articleId })
      showToast(t('unrecommended'))
    },
    [store, t],
  )
}

/** Recommend, or Recommended on ink once it is, with the count beside it where one is given. */
export function RecommendButton({
  recommended,
  count,
  onClick,
  testId,
}: {
  recommended: boolean
  count?: number
  onClick: () => void
  testId: string
}) {
  const t = useTranslations('reader')
  return (
    <button
      type="button"
      aria-pressed={recommended}
      data-testid={testId}
      onClick={onClick}
      className={`flex items-center gap-1.5 rounded-full border px-3.5 py-[7px] font-medium hover:border-ink ${
        recommended ? 'border-ink bg-ink text-paper' : 'border-thumb bg-transparent text-ink'
      }`}
    >
      <Glyph size={14} className="shrink-0">
        {PASS}
      </Glyph>
      <span>{recommended ? t('recommendedLabel') : t('recommend')}</span>
      {count === undefined ? null : <span className="opacity-70">{count}</span>}
    </button>
  )
}

/**
 * "Recommend to your readers", with an optional note shown on the member's profile and to the
 * author. The toolbar's popover and the box at the end of an article both hold it, and so does the
 * phone's bottom sheet (`sheet`), which names the post under the title and gives the two buttons a
 * thumb's room. The field has focus as it opens, since the note is the one thing to do here; Esc
 * and Cancel close it, and the reader's own Esc, which closes the article, never sees that Esc.
 */
export function RecommendForm({
  articleId,
  note,
  onClose,
  sheet,
}: {
  articleId: number
  note: string | null
  onClose: () => void
  /** The bottom sheet's layout: its title's id (the dialog's name) and the post it is about. */
  sheet?: { titleId: string; post: string }
}) {
  const t = useTranslations('reader')
  const { store } = useStore()
  const [text, setText] = useState(note ?? '')
  const field = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    field.current?.focus()
  }, [])

  // Applied here at once and synced behind it; the counts are the local view's (ADR 0025).
  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    const kept = text.trim()
    store.mutate({ type: 'recommend', articleId, note: kept || null })
    onClose()
    showToast(kept ? t('recommendedWithNote') : t('recommended'))
  }

  const onEscape = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    }
  }
  const textarea = (className: string) => (
    <textarea
      ref={field}
      value={text}
      onChange={(e) => setText(e.target.value.slice(0, RECOMMENDATION_NOTE_MAX))}
      placeholder={t('recommendPlaceholder')}
      rows={3}
      data-testid="recommend-note"
      className={`w-full resize-none border border-line bg-paper font-serif text-ink outline-none focus:border-muted ${className}`}
    />
  )

  if (sheet) {
    return (
      <form className="flex flex-col gap-3.5" onSubmit={submit} onKeyDown={onEscape}>
        <div>
          <div id={sheet.titleId} className="text-base font-semibold">
            {t('recommendTitle')}
          </div>
          <div className="mt-[3px] text-[13px] text-muted">{sheet.post}</div>
        </div>
        {textarea('min-h-[104px] rounded-[10px] px-3.5 py-3 text-[17px] leading-[1.45]')}
        <span className="text-[12.5px] text-muted">{t('recommendHint')}</span>
        <div className="flex gap-2.5">
          <button
            type="button"
            onClick={onClose}
            className="min-h-[46px] flex-1 rounded-full border border-thumb font-medium text-ink hover:border-ink"
          >
            {t('cancel')}
          </button>
          <button
            type="submit"
            data-testid="recommend-submit"
            className="min-h-[46px] flex-[2] rounded-full bg-ink font-medium text-paper hover:brightness-125"
          >
            {t('recommend')}
          </button>
        </div>
      </form>
    )
  }

  return (
    <form className="flex flex-col gap-2.5" onSubmit={submit} onKeyDown={onEscape}>
      <div className="font-medium">{t('recommendTitle')}</div>
      {textarea('rounded-lg px-3 py-2.5 text-base leading-[1.4]')}
      <div className="flex items-center gap-2">
        <span className="flex-1 text-xs text-muted">{t('recommendHint')}</span>
        <button
          type="button"
          onClick={onClose}
          className="rounded-md px-2.5 py-1.5 text-muted hover:bg-hover hover:text-ink"
        >
          {t('cancel')}
        </button>
        <button
          type="submit"
          data-testid="recommend-submit"
          className="rounded-full bg-ink px-3.5 py-[7px] font-medium text-paper hover:brightness-125"
        >
          {t('recommend')}
        </button>
      </div>
    </form>
  )
}

type Props = {
  articleId: number
  recommended: boolean
  note: string | null
  recommendCount: number
  /** Whether the form is open here; the reader keeps one Recommend form open at a time. */
  open: boolean
  onOpenChange: (open: boolean) => void
}

/** The toolbar's Recommend: the button, and the form under it in a popover. */
export function RecommendPopover({
  articleId,
  recommended,
  note,
  recommendCount,
  open,
  onOpenChange,
}: Props) {
  const t = useTranslations('reader')
  const unrecommend = useUnrecommend()
  return (
    <div className="relative">
      <RecommendButton
        recommended={recommended}
        count={recommendCount}
        testId="recommend-button"
        onClick={() => (recommended ? unrecommend(articleId) : onOpenChange(!open))}
      />
      {open && !recommended ? (
        <div
          role="dialog"
          aria-label={t('recommendTitle')}
          className="absolute right-0 top-[calc(100%+8px)] z-[6] w-80 rounded-xl border border-line bg-surface p-3.5 shadow-[0_12px_32px_rgba(0,0,0,.10)] animate-fade"
          data-testid="recommend-popover"
        >
          <RecommendForm articleId={articleId} note={note} onClose={() => onOpenChange(false)} />
        </div>
      ) : null}
    </div>
  )
}

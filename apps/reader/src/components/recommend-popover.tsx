import { RECOMMENDATION_NOTE_MAX } from '@tela/shared'
import { useEffect, useState } from 'react'
import { useTranslations } from 'use-intl'
import { useStore } from '../store/hooks'

type Props = {
  articleId: number
  recommended: boolean
  note: string | null
  recommendCount: number
}

/** "Recommend" with an optional note, shown on the member's profile and to the author. */
export function RecommendPopover({ articleId, recommended, note, recommendCount }: Props) {
  const t = useTranslations('reader')
  const { store } = useStore()
  const [open, setOpen] = useState(false)
  const [text, setText] = useState(note ?? '')
  const [toast, setToast] = useState<string | null>(null)

  useEffect(() => {
    if (!toast) return
    const timer = setTimeout(() => setToast(null), 2600)
    return () => clearTimeout(timer)
  }, [toast])

  // Applied here at once and synced behind it; the counts are the local view's (ADR 0025).
  const submit = () => {
    store.mutate({ type: 'recommend', articleId, note: text.trim() || null })
    setOpen(false)
    setToast(text.trim() ? t('recommendedWithNote') : t('recommended'))
  }

  const remove = () => {
    store.mutate({ type: 'unrecommend', articleId })
    setToast(t('unrecommended'))
  }

  return (
    <div className="relative">
      <button
        type="button"
        aria-pressed={recommended}
        data-testid="recommend-button"
        onClick={() => (recommended ? remove() : setOpen((o) => !o))}
        className={`flex items-center gap-1.5 rounded-full border px-3.5 py-[7px] font-medium hover:border-ink ${
          recommended ? 'border-ink bg-ink text-paper' : 'border-thumb bg-transparent text-ink'
        }`}
      >
        <span aria-hidden="true">↗</span>
        <span>{recommended ? t('recommendedLabel') : t('recommend')}</span>
        <span className="opacity-70">{recommendCount}</span>
      </button>
      {open ? (
        <div
          className="absolute right-0 top-[calc(100%+8px)] z-[6] flex w-80 flex-col gap-2.5 rounded-xl border border-line bg-white p-3.5 shadow-[0_12px_32px_rgba(0,0,0,.10)] animate-fade"
          data-testid="recommend-popover"
        >
          <div className="font-medium">{t('recommendTitle')}</div>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value.slice(0, RECOMMENDATION_NOTE_MAX))}
            placeholder={t('recommendPlaceholder')}
            rows={3}
            data-testid="recommend-note"
            className="w-full resize-none rounded-lg border border-line bg-paper px-3 py-2.5 font-serif text-base leading-[1.4] text-ink outline-none focus:border-muted"
          />
          <div className="flex items-center gap-2">
            <span className="flex-1 text-xs text-muted">{t('recommendHint')}</span>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="rounded-md px-2.5 py-1.5 text-muted hover:bg-hover hover:text-ink"
            >
              {t('cancel')}
            </button>
            <button
              type="button"
              onClick={submit}
              data-testid="recommend-submit"
              className="rounded-full bg-ink px-3.5 py-[7px] font-medium text-paper hover:brightness-125"
            >
              {t('recommend')}
            </button>
          </div>
        </div>
      ) : null}
      {toast ? (
        <div
          role="status"
          data-testid="toast"
          className="fixed bottom-7 left-1/2 z-10 -translate-x-1/2 rounded-[10px] bg-ink px-[18px] py-3 text-[13.5px] text-paper shadow-[0_8px_24px_rgba(0,0,0,.18)] animate-fade"
        >
          {toast}
        </div>
      ) : null}
    </div>
  )
}

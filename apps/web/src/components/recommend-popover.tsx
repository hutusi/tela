'use client'

import { RECOMMENDATION_NOTE_MAX } from '@tela/shared'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { useEffect, useState, useTransition } from 'react'
import { recommendAction, unrecommendAction } from '@/app/reading/actions'

type Props = {
  articleId: number
  recommended: boolean
  note: string | null
  recommendCount: number
}

/** "Recommend" with an optional note, shown on the member's profile and to the author. */
export function RecommendPopover({ articleId, recommended, note, recommendCount }: Props) {
  const t = useTranslations('reader')
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [text, setText] = useState(note ?? '')
  const [state, setState] = useState({ recommended, recommendCount })
  const [toast, setToast] = useState<string | null>(null)
  const [pending, start] = useTransition()

  useEffect(() => {
    if (!toast) return
    const timer = setTimeout(() => setToast(null), 2600)
    return () => clearTimeout(timer)
  }, [toast])

  const submit = () =>
    start(async () => {
      const result = await recommendAction(articleId, text)
      setState({ recommended: true, recommendCount: result.recommendCount })
      setOpen(false)
      setToast(text.trim() ? t('recommendedWithNote') : t('recommended'))
      router.refresh()
    })

  const remove = () =>
    start(async () => {
      const result = await unrecommendAction(articleId)
      setState({ recommended: false, recommendCount: result.recommendCount })
      setToast(t('unrecommended'))
      router.refresh()
    })

  return (
    <div className="relative">
      <button
        type="button"
        disabled={pending}
        aria-pressed={state.recommended}
        data-testid="recommend-button"
        onClick={() => (state.recommended ? remove() : setOpen((o) => !o))}
        className={`flex items-center gap-1.5 rounded-full border px-3.5 py-[7px] font-medium hover:border-ink disabled:opacity-70 ${
          state.recommended
            ? 'border-ink bg-ink text-paper'
            : 'border-thumb bg-transparent text-ink'
        }`}
      >
        <span aria-hidden="true">↗</span>
        <span>{state.recommended ? t('recommendedLabel') : t('recommend')}</span>
        <span className="opacity-70">{state.recommendCount}</span>
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
              disabled={pending}
              data-testid="recommend-submit"
              className="rounded-full bg-ink px-3.5 py-[7px] font-medium text-paper hover:brightness-125 disabled:opacity-60"
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

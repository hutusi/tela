'use client'

import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { useCallback, useEffect, useState } from 'react'
import { requestTranslationAction } from '@/app/reading/actions'

type Notice = 'rateLimited' | 'budgetExhausted'

/**
 * Ask the worker for a body translation: automatically as soon as a foreign article opens
 * (`auto`), or on demand as a "try again" button after a failed one (`button`).
 */
export function RequestTranslation({
  articleId,
  targetLang,
  mode = 'auto',
}: {
  articleId: number
  targetLang: string
  mode?: 'auto' | 'button'
}) {
  const router = useRouter()
  const t = useTranslations('translation')
  const [notice, setNotice] = useState<Notice | null>(null)
  const [busy, setBusy] = useState(false)
  const settle = useCallback(
    (outcome: Awaited<ReturnType<typeof requestTranslationAction>>) => {
      if (outcome === 'rate_limited') setNotice('rateLimited')
      else if (outcome === 'budget_exhausted') setNotice('budgetExhausted')
      // In `auto` mode a PollUntil is already mounted and refreshes once the request has
      // actually changed something. Refreshing here as well only re-rendered the page to show
      // the same "requested" state it will show again a moment later.
      else if (mode === 'button') router.refresh()
    },
    [router, mode],
  )
  useEffect(() => {
    if (mode !== 'auto') return
    let cancelled = false
    requestTranslationAction(articleId, targetLang).then((outcome) => {
      if (!cancelled) settle(outcome)
    })
    return () => {
      cancelled = true
    }
  }, [articleId, targetLang, mode, settle])
  if (notice !== null) {
    return (
      <p className="text-[13px] text-muted" data-testid={`translation-${notice}`}>
        {t(notice)}
      </p>
    )
  }
  if (mode !== 'button') return null
  return (
    <button
      type="button"
      disabled={busy}
      data-testid="translation-retry"
      className="mb-7 rounded-full border border-line bg-white px-3.5 py-1.5 text-[13px] hover:border-muted disabled:opacity-50"
      onClick={async () => {
        setBusy(true)
        settle(await requestTranslationAction(articleId, targetLang))
        setBusy(false)
      }}
    >
      {t('retry')}
    </button>
  )
}

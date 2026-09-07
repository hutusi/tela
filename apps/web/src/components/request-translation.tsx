'use client'

import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { useCallback, useEffect, useState } from 'react'
import { requestTranslationAction } from '@/app/reading/actions'
import { PollUntil } from './poll-until'
import {
  type TranslationRequestNotice,
  translationRequestDecision,
} from './translation-request-state'

/**
 * Ask the worker for a body translation: automatically as soon as a foreign article opens
 * (`auto`), or on demand as a "try again" button after a failed one (`button`). Once accepted,
 * this component owns the poller too, so a refused request cannot leave one running beside it.
 */
export function RequestTranslation({
  articleId,
  targetLang,
  mode = 'auto',
  revision,
  pollInitially = false,
}: {
  articleId: number
  targetLang: string
  mode?: 'auto' | 'button'
  revision: string
  /** Other work, currently full-text extraction, already requires this article to be polled. */
  pollInitially?: boolean
}) {
  const router = useRouter()
  const t = useTranslations('translation')
  const [notice, setNotice] = useState<TranslationRequestNotice | null>(null)
  const [translationPolling, setTranslationPolling] = useState(false)
  const [busy, setBusy] = useState(false)
  const settle = useCallback(
    (outcome: Awaited<ReturnType<typeof requestTranslationAction>>) => {
      const decision = translationRequestDecision(outcome)
      setTranslationPolling(decision.poll === true)
      setNotice(decision.notice ?? null)
      if (decision.refresh) router.refresh()
    },
    [router],
  )
  const request = useCallback(async () => {
    const outcome = await requestTranslationAction(articleId, targetLang).catch(
      () => 'unavailable' as const,
    )
    // Bind an automatic attempt to the server revision that decided it was needed. A changed
    // revision starts a fresh effect, which is how a stale running attempt is retried once it ends.
    return { outcome, revision }
  }, [articleId, targetLang, revision])
  useEffect(() => {
    if (mode !== 'auto') return
    let cancelled = false
    setBusy(true)
    request()
      .then(({ outcome }) => {
        if (!cancelled) settle(outcome)
      })
      .finally(() => {
        if (!cancelled) setBusy(false)
      })
    return () => {
      cancelled = true
    }
  }, [mode, request, settle])
  const blocked = notice === 'rateLimited' || notice === 'budgetExhausted'
  const showButton =
    !translationPolling && !blocked && (mode === 'button' || notice === 'unavailable')
  return (
    <>
      {notice ? (
        <p className="text-[13px] text-muted" data-testid={`translation-${notice}`}>
          {t(notice)}
        </p>
      ) : null}
      {showButton ? (
        <button
          type="button"
          disabled={busy}
          data-testid="translation-retry"
          className="mb-7 rounded-full border border-line bg-white px-3.5 py-1.5 text-[13px] hover:border-muted disabled:opacity-50"
          onClick={async () => {
            setBusy(true)
            setNotice(null)
            settle((await request()).outcome)
            setBusy(false)
          }}
        >
          {t('retry')}
        </button>
      ) : null}
      {pollInitially || translationPolling ? (
        <PollUntil articleId={articleId} lang={targetLang} revision={revision} />
      ) : null}
    </>
  )
}

'use client'

import { useTranslations } from 'next-intl'
import { useCallback, useEffect, useState } from 'react'
import { requestTranslationAction } from '@/app/reading/actions'
import { PollUntil } from './poll-until'
import {
  type TranslationRequestDecision,
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
  onReload,
  pollInitially = false,
}: {
  articleId: number
  targetLang: string
  mode?: 'auto' | 'button'
  revision: string
  /** Re-fetch the reader pane; far cheaper than re-rendering the page. */
  onReload: () => void
  /** Other work, currently full-text extraction, already requires this article to be polled. */
  pollInitially?: boolean
}) {
  const t = useTranslations('translation')
  // What the last request decided, and which server revision it decided it for. Scoping it that
  // way is what lets the retry button come back: a poll refreshes the page the moment an attempt
  // lands, and this component keeps its identity across that render, so a "polling" flag left
  // over from the previous revision would hide the button for good.
  const [decided, setDecided] = useState<{
    revision: string
    decision: TranslationRequestDecision
  } | null>(null)
  const [busy, setBusy] = useState(false)
  const current = decided?.revision === revision ? decided.decision : null
  const notice: TranslationRequestNotice | null = current?.notice ?? null
  const translationPolling = current?.poll === true
  const settle = useCallback(
    (outcome: Awaited<ReturnType<typeof requestTranslationAction>>, forRevision: string) => {
      const decision = translationRequestDecision(outcome)
      setDecided({ revision: forRevision, decision })
      if (decision.refresh) onReload()
    },
    [onReload],
  )
  const request = useCallback(async () => {
    const outcome = await requestTranslationAction(articleId, targetLang).catch(
      () => 'unavailable' as const,
    )
    // Bind the attempt to the server revision that decided it was needed. A changed revision
    // starts a fresh effect, which is how a stale running attempt is retried once it ends, and it
    // is what the outcome above is filed under.
    return { outcome, revision }
  }, [articleId, targetLang, revision])
  useEffect(() => {
    if (mode !== 'auto') return
    let cancelled = false
    setBusy(true)
    request()
      .then(({ outcome, revision: forRevision }) => {
        if (!cancelled) settle(outcome, forRevision)
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
            setDecided(null)
            const { outcome, revision: forRevision } = await request()
            settle(outcome, forRevision)
            setBusy(false)
          }}
        >
          {t('retry')}
        </button>
      ) : null}
      {pollInitially || translationPolling ? (
        <PollUntil
          articleId={articleId}
          lang={targetLang}
          revision={revision}
          onChanged={onReload}
        />
      ) : null}
    </>
  )
}

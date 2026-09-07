'use client'

import { useTranslations } from 'next-intl'
import { useEffect } from 'react'

/**
 * The reading panes render behind Suspense boundaries, so a query that fails arrives here rather
 * than as a blank column. Retrying re-runs the segment, which is the right move for the failure
 * this page actually has: a database round trip that did not come back.
 */
export default function ReadingError({
  error,
  retry,
}: {
  error: Error & { digest?: string }
  retry: () => void
}) {
  const t = useTranslations('reader')
  useEffect(() => {
    console.error('[tela] reading page failed', { digest: error.digest, message: error.message })
  }, [error])
  return (
    <main
      className="flex flex-1 items-center justify-center p-10 text-muted"
      data-testid="reading-error"
    >
      <div className="max-w-[280px] text-center text-[13.5px] leading-normal">
        <p className="m-0">{t('loadFailed')}</p>
        <button
          type="button"
          onClick={() => retry()}
          className="mt-3 rounded-full border border-line bg-white px-3.5 py-1.5 font-medium text-ink hover:border-ink"
        >
          {t('retry')}
        </button>
      </div>
    </main>
  )
}

/**
 * What a page that reads tela-api says when its answer did not come (offline, an error), in the
 * skeleton's place: one line and Try again, never a skeleton that waits for ever. A public page
 * also asks again by itself once the browser is back online (`usePublic`).
 */
import { useTranslations } from 'use-intl'
import { PageFailed } from './error-boundary'

export function LoadFailed({
  onRetry,
  className = 'py-12',
}: {
  onRetry: () => void
  /** Its room on the page: padding, by default, as the empty lists have. */
  className?: string
}) {
  const t = useTranslations('reader')
  return (
    <div className={`text-center text-muted ${className}`} data-testid="load-failed">
      <p className="m-0">{t('loadFailed')}</p>
      <button
        type="button"
        onClick={onRetry}
        className="mt-2 underline hover:text-ink"
        data-testid="load-failed-retry"
      >
        {t('retry')}
      </button>
    </div>
  )
}

/**
 * A page that has nothing to show until its answer comes: the whole page says it failed, as a page
 * whose render threw does (`PageFailed`), since to the reader the two are one situation.
 */
export function LoadFailedPage({ onRetry }: { onRetry: () => void }) {
  const t = useTranslations('reader')
  return (
    <PageFailed
      message={t('loadFailed')}
      retry={t('retry')}
      onRetry={onRetry}
      testId="load-failed"
    />
  )
}

/**
 * The words for what adding blogs came to (ADR 0063), shared by the Add page and Settings: why an
 * add was refused, a member's limit included, and what an import did, with when the blogs that
 * wait will arrive.
 */
import { daysToArrive } from '@tela/shared'
import { useLocale, useTranslations } from 'use-intl'
import type { AddProblem, Imported } from '../lib/opml'

/** A time of day in the reader's own clock: when a UTC day's allowance comes back (08:00 in Beijing). */
export function useClockTime(): (at: number) => string {
  const locale = useLocale()
  const format = new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit' })
  return (at) => format.format(at)
}

/** A refusal in words. */
export function useAddProblemWords(): (problem: AddProblem) => string {
  const t = useTranslations('add.errors')
  const time = useClockTime()
  return (p) => {
    if (p.error === 'feed_limit') {
      return t('feed_limit', { limit: p.limit ?? 0, time: time(p.resetsAt ?? Date.now()) })
    }
    if (p.error === 'subscription_limit') return t('subscription_limit', { limit: p.limit ?? 0 })
    return t(p.error)
  }
}

/** What an import did: how many it brought, then what waits and what was left out, if any. */
export function ImportSummary({ result }: { result: Imported }) {
  const t = useTranslations('add')
  const waiting = result.waiting ?? 0
  const over = result.over ?? 0
  const perDay = result.perDay ?? null
  const days = daysToArrive(waiting, perDay)
  return (
    <>
      {t('imported', { n: result.feeds })}
      {waiting > 0 ? (
        <>
          {' '}
          <span data-testid="opml-waiting">
            {days === null || perDay === null
              ? t('importPaused', { n: waiting })
              : t('importWaiting', { perDay, n: waiting, days })}
          </span>
        </>
      ) : null}
      {over > 0 && result.maxSubscriptions != null ? (
        <>
          {' '}
          <span data-testid="opml-over">
            {t('importOver', { n: over, max: result.maxSubscriptions })}
          </span>
        </>
      ) : null}
    </>
  )
}

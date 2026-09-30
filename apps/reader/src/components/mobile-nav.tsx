import { Link } from 'react-router'
import { useTranslations } from 'use-intl'
import { type ReadingParams, readingHref } from '../lib/href'
import type { SubscriptionItem, Totals } from '../store/selectors'
import { Swatch } from './swatch'

type Props = { subscriptions: SubscriptionItem[]; totals: Totals; params: ReadingParams }

/**
 * Below the desktop breakpoint the sidebar is hidden, so the filters and subscriptions live in a
 * disclosure above the list. It only renders while no article is open (stacked fallback).
 */
export function MobileNav({ subscriptions, totals, params }: Props) {
  const t = useTranslations('sidebar')
  const tn = useTranslations('nav')
  const current =
    params.feedId !== null
      ? (subscriptions.find((s) => s.feedId === params.feedId)?.title ?? t('subscriptions'))
      : t(params.filter)
  const row = (href: string, label: string, count: number, active: boolean) => (
    <Link
      to={href}
      className={`flex items-center justify-between gap-3 rounded-lg px-3 py-2 text-ink hover:bg-hover hover:no-underline ${active ? 'bg-hover font-medium' : ''}`}
      aria-current={active ? 'page' : undefined}
    >
      <span className="truncate">{label}</span>
      <span className="text-xs text-muted">{count || ''}</span>
    </Link>
  )
  return (
    <details
      className="border-b border-line bg-paper group-data-[open=1]:hidden lg:hidden"
      data-testid="mobile-nav"
    >
      <summary className="flex cursor-pointer list-none items-center justify-between px-5 py-3 font-medium">
        <span className="truncate">{current}</span>
        <span className="text-xs text-muted">{t('browse')} ▾</span>
      </summary>
      <div className="flex flex-col gap-0.5 px-2 pb-3">
        {row(
          readingHref({ filter: 'all' }),
          t('all'),
          totals.all,
          params.feedId === null && params.filter === 'all',
        )}
        {row(
          readingHref({ filter: 'today' }),
          t('today'),
          totals.today,
          params.feedId === null && params.filter === 'today',
        )}
        {row(
          readingHref({ filter: 'liked' }),
          t('liked'),
          totals.liked,
          params.feedId === null && params.filter === 'liked',
        )}
        <div className="px-3 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">
          {t('subscriptions')}
        </div>
        {subscriptions.map((s) => (
          <Link
            key={s.feedId}
            to={readingHref({ feedId: s.feedId })}
            className={`flex items-center gap-2.5 rounded-lg px-3 py-2 text-ink hover:bg-hover hover:no-underline ${params.feedId === s.feedId ? 'bg-hover font-medium' : ''}`}
            data-testid="mobile-subscription"
          >
            <Swatch id={s.feedId} title={s.title} size={18} />
            <span className="flex-1 truncate">{s.title}</span>
            <span className="text-xs text-muted">{s.unread || ''}</span>
          </Link>
        ))}
        <Link
          to="/add"
          className="mt-1 rounded-lg border border-dashed border-thumb px-3 py-2 text-muted hover:border-muted hover:text-ink hover:no-underline"
        >
          {tn('addFeed')}
        </Link>
      </div>
    </details>
  )
}

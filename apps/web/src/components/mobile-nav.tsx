import type { SubscriptionRow, UnreadTotals } from '@tela/db/queries'
import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import { type ReadingParams, readingHref } from '@/app/reading/href'
import { Swatch } from './swatch'

type Props = { subscriptions: SubscriptionRow[]; totals: UnreadTotals; params: ReadingParams }

/**
 * Below the desktop breakpoint the sidebar is hidden, so the filters and subscriptions live in a
 * disclosure above the article list. The reader replaces the list on small screens (stacked
 * fallback: list → article as a page), so this only renders while no article is open.
 */
export async function MobileNav({ subscriptions, totals, params }: Props) {
  const t = await getTranslations('sidebar')
  const tn = await getTranslations('nav')
  const current =
    params.feedId !== null
      ? (subscriptions.find((s) => s.feedId === params.feedId)?.title ?? t('subscriptions'))
      : t(params.filter)
  const row = (href: string, label: string, count: number, active: boolean, testId?: string) => (
    <Link
      href={href}
      className={`flex items-center justify-between gap-3 rounded-lg px-3 py-2 text-ink hover:bg-hover hover:no-underline ${active ? 'bg-hover font-medium' : ''}`}
      aria-current={active ? 'page' : undefined}
      data-testid={testId}
    >
      <span className="truncate">{label}</span>
      <span className="text-xs text-muted">{count || ''}</span>
    </Link>
  )
  return (
    <details className="border-b border-line bg-paper lg:hidden" data-testid="mobile-nav">
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
            href={readingHref({ feedId: s.feedId })}
            className={`flex items-center gap-2.5 rounded-lg px-3 py-2 text-ink hover:bg-hover hover:no-underline ${params.feedId === s.feedId ? 'bg-hover font-medium' : ''}`}
            data-testid="mobile-subscription"
          >
            <Swatch id={s.feedId} title={s.title} size={18} />
            <span className="flex-1 truncate">{s.title}</span>
            <span className="text-xs text-muted">{s.unread || ''}</span>
          </Link>
        ))}
        <Link
          href="/add"
          className="mt-1 rounded-lg border border-dashed border-thumb px-3 py-2 text-muted hover:border-muted hover:text-ink hover:no-underline"
        >
          {tn('addFeed')}
        </Link>
      </div>
    </details>
  )
}

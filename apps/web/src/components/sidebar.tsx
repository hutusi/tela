import type { SubscriptionRow, UnreadTotals } from '@tela/db/queries'
import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import { type ReadingParams, readingHref } from '@/app/reading/href'
import { Swatch } from './swatch'

type Props = { subscriptions: SubscriptionRow[]; totals: UnreadTotals; params: ReadingParams }

export async function Sidebar({ subscriptions, totals, params }: Props) {
  const t = await getTranslations('sidebar')
  const tn = await getTranslations('nav')
  const filterRow = (filter: ReadingParams['filter'], label: string, count: number) => {
    const active = params.feedId === null && params.filter === filter
    return (
      <Link
        href={readingHref({ filter })}
        className={`flex items-center justify-between rounded-lg px-3 py-2 font-medium text-ink hover:bg-hover hover:no-underline ${active ? 'bg-hover' : ''}`}
        aria-current={active ? 'page' : undefined}
      >
        <span>{label}</span>
        <span className="text-xs text-muted">{count || ''}</span>
      </Link>
    )
  }
  return (
    <aside className="hidden flex-col gap-6 border-r border-line px-3.5 py-5 lg:sticky lg:top-14 lg:flex lg:h-[calc(100vh-56px)] lg:overflow-auto">
      <nav className="flex flex-col gap-0.5" aria-label={tn('reading')}>
        {filterRow('all', t('all'), totals.all)}
        {filterRow('today', t('today'), totals.today)}
        {filterRow('liked', t('liked'), totals.liked)}
      </nav>
      <div className="flex flex-col gap-0.5">
        <div className="px-3 pb-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">
          {t('subscriptions')}
        </div>
        {subscriptions.length === 0 ? (
          <p className="px-3 text-[13px] text-muted">{t('noSubscriptions')}</p>
        ) : null}
        {subscriptions.map((s) => {
          const active = params.feedId === s.feedId
          return (
            <Link
              key={s.feedId}
              href={readingHref({ feedId: s.feedId })}
              className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-[7px] text-left text-ink hover:bg-hover hover:no-underline ${active ? 'bg-hover' : ''}`}
              aria-current={active ? 'page' : undefined}
              data-testid="subscription"
            >
              <Swatch id={s.feedId} title={s.title} size={18} />
              <span className="flex-1 truncate">{s.title}</span>
              <span className="text-xs text-muted">{s.unread || ''}</span>
            </Link>
          )
        })}
        <Link
          href="/add"
          className="mt-2 rounded-lg border border-dashed border-thumb px-3 py-2 text-left text-muted hover:border-muted hover:text-ink hover:no-underline"
          data-testid="add-feed"
        >
          {tn('addFeed')}
        </Link>
      </div>
    </aside>
  )
}

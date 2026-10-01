import { Link } from 'react-router'
import { useTranslations } from 'use-intl'
import { type ReadingParams, readingHref } from '../lib/href'
import type { Filter, SubscriptionItem, Totals } from '../store/selectors'
import { ManageSubscriptions } from './manage-subscriptions'
import { SidebarToggle, TOGGLE_ROW } from './sidebar-toggle'
import { Swatch } from './swatch'

type Props = { subscriptions: SubscriptionItem[]; totals: Totals; params: ReadingParams }

export function Sidebar({ subscriptions, totals, params }: Props) {
  const t = useTranslations('sidebar')
  const tn = useTranslations('nav')
  const filterRow = (filter: Filter, label: string, count: number) => {
    const active = params.feedId === null && params.filter === filter
    return (
      <Link
        to={readingHref({ filter })}
        className={`flex items-center justify-between rounded-lg px-3 py-2 font-medium text-ink hover:bg-hover hover:no-underline ${active ? 'bg-hover' : ''}`}
        aria-current={active ? 'page' : undefined}
      >
        <span>{label}</span>
        <span className="text-xs text-muted">{count || ''}</span>
      </Link>
    )
  }
  return (
    <aside
      data-testid="sidebar"
      className="hidden flex-col border-r border-line px-3.5 pb-5 lg:sticky lg:top-14 lg:flex lg:h-[calc(100vh-56px)] lg:overflow-auto"
    >
      {/* "Library" at the headings' indent, and the icon's right edge on the counts' (pr-0.5 plus
          the button's px-2.5 makes their px-3). A child of the aside itself, the scroller, so it
          can stick; it carries the top padding the aside dropped, so it looks the same stuck or
          at rest. */}
      <div className={`${TOGGLE_ROW} justify-between pl-3 pr-0.5`}>
        <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">
          {t('library')}
        </span>
        <SidebarToggle className="-my-1.5" />
      </div>
      <div className="flex flex-col gap-6">
        <nav className="flex flex-col gap-0.5" aria-label={tn('reading')}>
          {filterRow('all', t('all'), totals.all)}
          {filterRow('today', t('today'), totals.today)}
          {filterRow('liked', t('liked'), totals.liked)}
        </nav>
        <div className="flex flex-col gap-0.5">
          {/* The heading at the headings' indent, and Manage's glyph on the counts' right edge, as
              the Library row has its toggle. */}
          <div className="flex items-center justify-between pb-2 pl-3 pr-0.5">
            <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">
              {t('subscriptions')}
            </span>
            <ManageSubscriptions className="-my-1.5" />
          </div>
          {subscriptions.length === 0 ? (
            <p className="px-3 text-[13px] text-muted">{t('noSubscriptions')}</p>
          ) : null}
          {subscriptions.map((s) => {
            const active = params.feedId === s.feedId
            return (
              <Link
                key={s.feedId}
                to={readingHref({ feedId: s.feedId })}
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
            to="/add"
            className="mt-2 rounded-lg border border-dashed border-thumb px-3 py-2 text-left text-muted hover:border-muted hover:text-ink hover:no-underline"
            data-testid="add-feed"
          >
            {tn('addFeed')}
          </Link>
        </div>
      </div>
    </aside>
  )
}

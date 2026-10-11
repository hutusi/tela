import { Link } from 'react-router'
import { useTranslations } from 'use-intl'
import { type ReadingParams, readingHref } from '../lib/href'
import type { SubscriptionItem, Totals } from '../store/selectors'
import { CHEVRON_DOWN, Glyph } from './glyph'
import { ManageSubscriptions } from './manage-subscriptions'
import { Swatch } from './swatch'

type Props = { subscriptions: SubscriptionItem[]; totals: Totals; params: ReadingParams }

/**
 * Below the desktop breakpoint the sidebar is hidden, so the filters and subscriptions live in a
 * disclosure above the list (Tela v5's phone screens 01 and 02): the list's name on the left, and
 * "Feeds" with a chevron on the right that turns over while it is open. Every row is a 40px target
 * at least, and Manage a 44 by 32 one. It only renders while no article is open.
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
      className={`flex min-h-10 items-center justify-between gap-3 rounded-lg px-3 py-2.5 text-ink hover:bg-hover hover:no-underline ${active ? 'bg-hover font-medium' : ''}`}
      aria-current={active ? 'page' : undefined}
    >
      <span className="truncate">{label}</span>
      <span className="text-xs text-muted">{count || ''}</span>
    </Link>
  )
  return (
    <details
      className="group/feeds border-b border-line bg-paper group-data-[open=1]:hidden lg:hidden"
      data-testid="mobile-nav"
    >
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-5 py-3 font-medium [&::-webkit-details-marker]:hidden">
        <span className="truncate">{current}</span>
        <span className="flex shrink-0 items-center gap-1 text-[12.5px] font-normal text-muted group-open/feeds:text-ink">
          {t('browse')}
          <Glyph size={12} className="group-open/feeds:rotate-180">
            {CHEVRON_DOWN}
          </Glyph>
        </span>
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
        <div className="flex items-center justify-between pb-1.5 pl-3 pr-0.5 pt-3.5">
          <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">
            {t('subscriptions')}
          </span>
          <ManageSubscriptions box="h-8 w-11" />
        </div>
        {subscriptions.map((s) => (
          <Link
            key={s.feedId}
            to={readingHref({ feedId: s.feedId })}
            className={`flex min-h-10 items-center gap-2.5 rounded-lg px-3 py-2.5 text-ink hover:bg-hover hover:no-underline ${params.feedId === s.feedId ? 'bg-hover font-medium' : ''}`}
            data-testid="mobile-subscription"
          >
            <Swatch id={s.feedId} title={s.title} size={18} />
            <span className="flex-1 truncate">{s.title}</span>
            <span className="text-xs text-muted">{s.unread || ''}</span>
          </Link>
        ))}
        <Link
          to="/add"
          className="mx-1 mt-1.5 rounded-lg border border-dashed border-thumb px-3 py-[11px] text-muted hover:border-muted hover:text-ink hover:no-underline"
        >
          {tn('addFeed')}
        </Link>
      </div>
    </details>
  )
}

import type { ReactNode } from 'react'
import { Link } from 'react-router'
import { useTranslations } from 'use-intl'
import { type ReadingParams, readingHref } from '../lib/href'
import type { Filter, SubscriptionItem } from '../store/selectors'
import { SidebarToggle, TOGGLE_ROW } from './sidebar-toggle'
import { Swatch } from './swatch'

type Props = { subscriptions: SubscriptionItem[]; params: ReadingParams }

/** The filters' glyphs, 16px and drawn like the toggle's panel, since Tela has no icon set. */
function Glyph({ children }: { children: ReactNode }) {
  return (
    <svg
      width={16}
      height={16}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  )
}

const GLYPHS: Record<Filter, ReactNode> = {
  all: <path d="M3 4.5h10M3 8h10M3 11.5h10" />,
  today: (
    <>
      <circle cx="8" cy="8" r="5.75" />
      <circle cx="8" cy="8" r="2.25" fill="currentColor" stroke="none" />
    </>
  ),
  liked: (
    <path d="M8 13.25S2.25 9.9 2.25 6.1C2.25 4.4 3.6 3 5.25 3 6.4 3 7.4 3.6 8 4.6 8.6 3.6 9.6 3 10.75 3c1.65 0 3 1.4 3 3.1 0 3.8-5.75 7.15-5.75 7.15Z" />
  ),
}

// One or the other, never both: two colour utilities in one class list have no defined winner.
const ITEM =
  'relative flex size-9 shrink-0 items-center justify-center rounded-lg hover:bg-hover hover:text-ink hover:no-underline'
const item = (active: boolean) => `${ITEM} ${active ? 'bg-hover text-ink' : 'text-muted'}`

/**
 * The sidebar collapsed (ADR 0030): 48px that keep the toggle, the three filters and a swatch per
 * feed, with the list's unread dot on a feed that has unread posts. The names are in each link's
 * label and tooltip, since there is no room to print them. From `lg`, like the sidebar; it
 * scrolls without a scrollbar, which would take a third of its width, and the toggle stays at its
 * top on the Library row's line, so between the two states it only moves sideways.
 */
export function SidebarRail({ subscriptions, params }: Props) {
  const t = useTranslations('sidebar')
  const tn = useTranslations('nav')
  const tr = useTranslations('reader')
  return (
    <aside
      className="hidden flex-col items-center border-r border-line pb-5 [scrollbar-width:none] lg:sticky lg:top-14 lg:flex lg:h-[calc(100vh-56px)] lg:overflow-y-auto lg:overflow-x-hidden"
      aria-label={t('library')}
      data-testid="sidebar-rail"
    >
      <div className={`${TOGGLE_ROW} w-full justify-center`}>
        <SidebarToggle className="-my-1.5" />
      </div>
      <div className="mb-3 h-px w-6 shrink-0 bg-line" />
      <nav className="flex flex-col items-center gap-1" aria-label={tn('reading')}>
        {(['all', 'today', 'liked'] as const).map((filter) => {
          const active = params.feedId === null && params.filter === filter
          return (
            <Link
              key={filter}
              to={readingHref({ filter })}
              className={item(active)}
              aria-current={active ? 'page' : undefined}
              aria-label={t(filter)}
              title={t(filter)}
            >
              <Glyph>{GLYPHS[filter]}</Glyph>
            </Link>
          )
        })}
      </nav>
      <div className="my-3 h-px w-6 shrink-0 bg-line" />
      <div className="flex flex-col items-center gap-1">
        {subscriptions.map((s) => {
          const active = params.feedId === s.feedId
          const label = s.unread ? `${s.title} · ${tr('unreadCount', { n: s.unread })}` : s.title
          return (
            <Link
              key={s.feedId}
              to={readingHref({ feedId: s.feedId })}
              className={item(active)}
              aria-current={active ? 'page' : undefined}
              aria-label={label}
              title={label}
              data-testid="rail-subscription"
            >
              <Swatch id={s.feedId} title={s.title} size={24} />
              {s.unread ? (
                <span
                  className="absolute right-0.5 top-0.5 size-[7px] rounded-full bg-accent ring-2 ring-paper"
                  data-testid="rail-unread"
                />
              ) : null}
            </Link>
          )
        })}
      </div>
    </aside>
  )
}

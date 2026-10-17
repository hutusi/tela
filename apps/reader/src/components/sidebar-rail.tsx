import type { ReactNode } from 'react'
import { Link } from 'react-router'
import { useTranslations } from 'use-intl'
import { listsFilter, type ReadingParams, readingHref } from '../lib/href'
import type { Filter, FolderItem, SubscriptionItem } from '../store/selectors'
import { Glyph, HEART, LIST } from './glyph'
import { SidebarToggle, TOGGLE_ROW } from './sidebar-toggle'
import { Swatch } from './swatch'

type Props = {
  tree: { folders: FolderItem[]; unfiled: SubscriptionItem[] }
  params: ReadingParams
}

/** The filters' glyphs: All and Liked from the drawn set, and Today's dot in a circle, its own. */
const GLYPHS: Record<Filter, ReactNode> = {
  all: LIST,
  today: (
    <>
      <circle cx="8" cy="8" r="5.75" />
      <circle cx="8" cy="8" r="2.25" fill="currentColor" stroke="none" />
    </>
  ),
  liked: HEART,
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
 *
 * Folders have no row here (ADR 0048): there is no room to name one, and a swatch for a folder
 * would read as a blog. The swatches keep the sidebar's order instead, each folder's blogs, open
 * or closed, and then the blogs in none, so a blog is where the sidebar has it.
 */
export function SidebarRail({ tree, params }: Props) {
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
        <SidebarToggle shown={false} className="-my-1.5" />
      </div>
      <div className="mb-3 h-px w-6 shrink-0 bg-line" />
      <nav className="flex flex-col items-center gap-1" aria-label={tn('reading')}>
        {(['all', 'today', 'liked'] as const).map((filter) => {
          const active = listsFilter(params, filter)
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
        {[...tree.folders.flatMap((f) => f.blogs), ...tree.unfiled].map((s) => {
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

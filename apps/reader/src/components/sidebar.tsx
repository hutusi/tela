import { Link } from 'react-router'
import { useTranslations } from 'use-intl'
import { useClosedFolders } from '../lib/folders-open'
import { listsFilter, type ReadingParams, readingHref } from '../lib/href'
import type { Filter, FolderItem, SubscriptionItem, Totals } from '../store/selectors'
import { FolderToggle } from './folder-toggle'
import { ManageSubscriptions } from './manage-subscriptions'
import { SidebarToggle, TOGGLE_ROW } from './sidebar-toggle'
import { Swatch } from './swatch'

type Props = {
  tree: { folders: FolderItem[]; unfiled: SubscriptionItem[] }
  totals: Totals
  params: ReadingParams
}

/**
 * A blog's row. In a folder it is indented to the folder's name; outside one, beside folders,
 * its swatch sits under their chevrons (Tela Lists). With no folder at all, it is as it was.
 */
const BLOG_ROW = {
  nested: 'py-1.5 pl-[34px] pr-3',
  unfiled: 'py-[7px] pl-2 pr-3',
  flat: 'px-3 py-[7px]',
} as const

/**
 * A row's unread count. `muted` is 4.05:1 on the `hover` ground, under AA at 12px, so on the open
 * row, and on one under the pointer, the count steps up to `ink-2`. The row is `group/row` by
 * name: the reading layout is a bare `group` of its own, hovered wherever the pointer is.
 */
export const rowCount = (active: boolean) =>
  `text-xs ${active ? 'text-ink-2' : 'text-muted group-hover/row:text-ink-2'}`

export function Sidebar({ tree, totals, params }: Props) {
  const t = useTranslations('sidebar')
  const tn = useTranslations('nav')
  const closed = useClosedFolders()
  const filterRow = (filter: Filter, label: string, count: number) => {
    const active = listsFilter(params, filter)
    return (
      <Link
        to={readingHref({ filter })}
        className={`group/row flex items-center justify-between rounded-lg px-3 py-2 font-medium text-ink hover:bg-hover hover:no-underline ${active ? 'bg-hover' : ''}`}
        aria-current={active ? 'page' : undefined}
      >
        <span>{label}</span>
        <span className={rowCount(active)}>{count || ''}</span>
      </Link>
    )
  }
  const blogRow = (s: SubscriptionItem, place: keyof typeof BLOG_ROW) => {
    const active = params.feedId === s.feedId
    return (
      <Link
        key={s.feedId}
        to={readingHref({ feedId: s.feedId })}
        className={`group/row flex w-full items-center gap-2.5 rounded-lg text-left text-ink hover:bg-hover hover:no-underline ${BLOG_ROW[place]} ${active ? 'bg-hover' : ''}`}
        aria-current={active ? 'page' : undefined}
        data-testid="subscription"
      >
        <Swatch id={s.feedId} title={s.title} size={18} />
        <span className="flex-1 truncate">{s.title}</span>
        <span className={rowCount(active)}>{s.unread || ''}</span>
      </Link>
    )
  }
  const filed = tree.folders.length > 0
  const subscribed = tree.unfiled.length + tree.folders.reduce((n, f) => n + f.blogs.length, 0)
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
        <SidebarToggle shown className="-my-1.5" />
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
          {subscribed === 0 ? (
            <p className="px-3 text-[13px] text-muted">{t('noSubscriptions')}</p>
          ) : null}
          {/* The member's folders by name, each open or closed on this device, then the blogs in
              none (ADR 0048). The chevron opens and closes; the name reads the whole folder. */}
          {tree.folders.map((f) => {
            const active = params.folderId === f.id
            const open = !closed.has(f.id)
            return (
              <div key={f.id} className="flex flex-col gap-0.5">
                <div
                  className={`group/row flex items-center rounded-lg hover:bg-hover ${active ? 'bg-hover' : ''}`}
                  data-testid="folder"
                  data-folder-id={f.id}
                >
                  <FolderToggle
                    folder={f}
                    open={open}
                    className="size-[34px]"
                    testId="folder-toggle"
                  />
                  <Link
                    to={readingHref({ folderId: f.id })}
                    className="flex min-w-0 flex-1 items-center justify-between gap-2 py-2 pr-3 font-medium text-ink hover:no-underline"
                    aria-current={active ? 'page' : undefined}
                    data-testid="folder-link"
                  >
                    <span className="truncate">{f.name}</span>
                    <span className={`font-normal ${rowCount(active)}`}>{f.unread || ''}</span>
                  </Link>
                </div>
                {open ? f.blogs.map((s) => blogRow(s, 'nested')) : null}
              </div>
            )
          })}
          {tree.unfiled.map((s) => blogRow(s, filed ? 'unfiled' : 'flat'))}
          <Link
            to="/add"
            className="mt-2 rounded-lg border border-dashed border-thumb px-3 py-2 text-left text-muted hover:border-muted hover:text-ink hover:no-underline"
            data-testid="add-feed"
          >
            {tn('addFeed')}
          </Link>
          <Link
            to="/discover/blogs"
            className="whitespace-nowrap px-3 pt-2 text-[12.5px] text-muted hover:text-ink hover:no-underline"
            data-testid="browse-discover"
          >
            {t('browseDiscover')}
          </Link>
        </div>
      </div>
    </aside>
  )
}

import { Link } from 'react-router'
import { useTranslations } from 'use-intl'
import { useClosedFolders } from '../lib/folders-open'
import { listsFilter, type ReadingParams, readingHref } from '../lib/href'
import type { FolderItem, SubscriptionItem, Totals } from '../store/selectors'
import { FolderToggle } from './folder-toggle'
import { CHEVRON_DOWN, Glyph } from './glyph'
import { ManageSubscriptions } from './manage-subscriptions'
import { Swatch } from './swatch'

type Props = {
  tree: { folders: FolderItem[]; unfiled: SubscriptionItem[] }
  totals: Totals
  params: ReadingParams
}

/**
 * Below the desktop breakpoint the sidebar is hidden, so the filters and subscriptions live in a
 * disclosure above the list (Tela v5's phone screens 01 and 02): the list's name on the left, and
 * "Feeds" with a chevron on the right that turns over while it is open. Every row is a 40px target
 * at least, and Manage a 44 by 32 one. It only renders while no article is open.
 *
 * The member's folders are in it as in the sidebar (Tela Lists, screen 19): a 44px row whose
 * chevron, a 44px target, opens and closes the folder on this device, and whose name reads the
 * whole folder; its blogs under it, indented to the name.
 */
export function MobileNav({ tree, totals, params }: Props) {
  const t = useTranslations('sidebar')
  const tn = useTranslations('nav')
  const closed = useClosedFolders()
  const blogs = [...tree.folders.flatMap((f) => f.blogs), ...tree.unfiled]
  const current =
    params.feedId !== null
      ? (blogs.find((s) => s.feedId === params.feedId)?.title ?? t('subscriptions'))
      : params.folderId !== null
        ? (tree.folders.find((f) => f.id === params.folderId)?.name ?? t('subscriptions'))
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
  const blogRow = (s: SubscriptionItem, nested: boolean) => (
    <Link
      key={s.feedId}
      to={readingHref({ feedId: s.feedId })}
      className={`flex min-h-10 items-center gap-2.5 rounded-lg py-2.5 pr-3 text-ink hover:bg-hover hover:no-underline ${nested ? 'pl-11' : 'pl-3'} ${params.feedId === s.feedId ? 'bg-hover font-medium' : ''}`}
      data-testid="mobile-subscription"
    >
      <Swatch id={s.feedId} title={s.title} size={18} />
      <span className="flex-1 truncate">{s.title}</span>
      <span className="text-xs text-muted">{s.unread || ''}</span>
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
        {row(readingHref({ filter: 'all' }), t('all'), totals.all, listsFilter(params, 'all'))}
        {row(
          readingHref({ filter: 'today' }),
          t('today'),
          totals.today,
          listsFilter(params, 'today'),
        )}
        {row(
          readingHref({ filter: 'liked' }),
          t('liked'),
          totals.liked,
          listsFilter(params, 'liked'),
        )}
        <div className="flex items-center justify-between pb-1.5 pl-3 pr-0.5 pt-3.5">
          <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">
            {t('subscriptions')}
          </span>
          <ManageSubscriptions box="h-8 w-11" />
        </div>
        {tree.folders.map((f) => {
          const active = params.folderId === f.id
          const open = !closed.has(f.id)
          return (
            <div key={f.id} className="flex flex-col gap-0.5">
              <div
                className={`flex min-h-11 items-center rounded-lg hover:bg-hover ${active ? 'bg-hover' : ''}`}
                data-testid="mobile-folder"
                data-folder-id={f.id}
              >
                <FolderToggle
                  folder={f}
                  open={open}
                  className="size-11"
                  testId="mobile-folder-toggle"
                />
                <Link
                  to={readingHref({ folderId: f.id })}
                  className="flex min-h-11 min-w-0 flex-1 items-center justify-between gap-3 pr-3 font-medium text-ink hover:no-underline"
                  aria-current={active ? 'page' : undefined}
                  data-testid="mobile-folder-link"
                >
                  <span className="truncate">{f.name}</span>
                  <span className="text-xs font-normal text-muted">{f.unread || ''}</span>
                </Link>
              </div>
              {open ? f.blogs.map((s) => blogRow(s, true)) : null}
            </div>
          )
        })}
        {tree.unfiled.map((s) => blogRow(s, false))}
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

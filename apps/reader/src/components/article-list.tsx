import { languageBadge, type ReadingLanguage } from '@tela/shared'
import type { ArticleRow } from '@tela/sync'
import { useState } from 'react'
import { Link, useLocation } from 'react-router'
import { useTranslations } from 'use-intl'
import { relativeTime } from '../lib/format'
import { canonicalReadingHref, type ReadingParams, readingHref } from '../lib/href'
import { readingPrefsOf } from '../lib/prefs'
import { showToast, UNDO_HOLD_MS } from '../lib/toasts'
import { offerUndo, unreadAgain } from '../lib/undo'
import { useStore, useTables } from '../store/hooks'
import type { Stamp } from '../store/local'
import { feedTitle, isRead, markAllReadCovers, shownRead, shownTitle } from '../store/selectors'
import { GlyphCount } from './glyph-count'
import { Segmented } from './segmented'
import { Swatch } from './swatch'

/** What a list shows: its unread posts, or every post (Tela v5's switch under the heading). */
export type ListShow = 'unread' | 'all'
const SHOWS: readonly ListShow[] = ['unread', 'all']

type Props = {
  items: ArticleRow[]
  params: ReadingParams
  title?: string | undefined
  readingLang: ReadingLanguage
  locale: string
  now: number
  pendingFetch?: boolean
  /** The switch's state, or null where the list has none (Liked, which always shows all). */
  show?: ListShow | null
  onShow?: (show: ListShow) => void
  /** Unread is shown, and the list has posts, all read: say so, not "no posts". */
  caughtUp?: boolean
  /**
   * Called as Mark all read is pressed, so a list of unread posts lets go of those it kept: even
   * when every one is read already and the press has nothing to send.
   */
  onMarkAll?: () => void
}

/**
 * The list's row for an article, with the list told to keep rows clear of its heading as one is
 * scrolled or focused into view: the heading sticks over the rows' top, and a row brought into
 * view at the list's top edge would sit hidden behind it. Its height is read when asked, since
 * it is not one height everywhere (wide or beside an article, on a phone).
 */
export function listRow(articleId: number): HTMLElement | null {
  const row = document.querySelector<HTMLElement>(
    `[data-testid="article-row"][data-article-id="${articleId}"]`,
  )
  const list = row?.closest<HTMLElement>('[data-testid="article-list"]')
  const head = list?.querySelector<HTMLElement>('[data-list-head]')
  if (list && head) list.style.scrollPaddingTop = `${head.offsetHeight}px`
  return row ?? null
}

/** How many rows render; older ones follow on request. The device holds the whole horizon. */
const PAGE = 200

const read = (articleId: number) => ({ type: 'markRead', articleId }) as const

export function ArticleList({
  items,
  params,
  title,
  readingLang,
  locale,
  now,
  pendingFetch = false,
  show = null,
  onShow,
  caughtUp = false,
  onMarkAll,
}: Props) {
  const t = useTranslations('list')
  const ts = useTranslations('sidebar')
  const tt = useTranslations('toast')
  const tables = useTables()
  const { store } = useStore()
  const location = useLocation()
  const heading = title ?? ts(params.filter)
  const { markOnOpen, never } = readingPrefsOf(tables)
  const target = languageBadge(readingLang)
  const [limit, setLimit] = useState(PAGE)
  const shown = items.slice(0, limit)
  // Liking a post reads it, so Liked has nothing to mark.
  const markable = items.length > 0 && !(params.feedId === null && params.filter === 'liked')
  const markAllRead = () => {
    onMarkAll?.()
    // The device's rows as they are when pressed, which the toast counts against.
    const before = store.getSnapshot().tables
    const at = Date.now()
    // Held on the device while the toast shows, so an Undo never reaches the server: a watermark
    // only moves forward (ADR 0025). Sent already (the tab was hidden meanwhile), an Undo marks
    // what it read unread one by one and later than it, unless that is too many to send.
    const offer = (ids: number[], held: Stamp[]) => {
      const last = held.at(-1)
      if (!last) return
      offerUndo(
        store,
        t('markedRead', { n: ids.length }),
        tt('undo'),
        held.map((s) => s.mid),
        () => {
          if (!unreadAgain(store, ids, last.at)) showToast(t('undoTooMany'))
        },
      )
    }
    if (params.feedId === null && params.filter === 'today') {
      // Today is a window the server knows nothing of: a mark-all up to its newest post would read
      // every older post of every feed too. So each unread post it holds, read on its own.
      const ids = items.filter((a) => !isRead(before, a, at)).map((a) => a.id)
      if (ids.length === 0) return
      offer(ids, store.mutateMany(ids.map(read), { holdMs: UNDO_HOLD_MS }))
      return
    }
    // Up to what the list displayed, never the server's newest: a post that arrived after the
    // reader looked stays unread (ADR 0025).
    const upTo = shown.reduce((max, a) => (a.id > max ? a.id : max), 0)
    if (upTo === 0) return
    const input = {
      type: 'markAllRead',
      upTo,
      ...(params.feedId ? { feedId: params.feedId } : {}),
    } as const
    // Counted from what the change does, as the server will apply it: every post of the scope up
    // to `upTo`, the ones this list never showed included.
    const covered = markAllReadCovers(before, { ...input, mid: '', at }, at)
    // Nothing it would read: a second press while the first one's Undo shows (sent anyway, it
    // would outlive that Undo), or a list read already. A post the device does not hold is past
    // the horizon, read already too. So nothing is sent, and there is nothing to undo.
    if (covered.length === 0) return
    const stamp = store.mutate(input, { holdMs: UNDO_HOLD_MS })
    if (stamp) offer(covered, [stamp])
  }
  return (
    <section
      className="min-w-0 border-r border-line group-data-[open=1]:hidden lg:sticky lg:top-14 lg:h-[calc(100vh-56px)] lg:overflow-y-auto lg:group-data-[open=1]:block"
      data-testid="article-list"
    >
      <div
        className="sticky top-0 z-[1] flex flex-col gap-2.5 bg-paper px-5 pb-2.5 pt-5"
        data-list-head
      >
        <h1 className="min-w-0 truncate font-serif font-medium tracking-tight text-[26px] group-data-[open=1]:text-[20px]">
          {heading}
        </h1>
        {/* The switch, and Mark all read at the row's end while the list is wide. Liked has
            neither: it is a shelf the member keeps, not an inbox, and liking a post reads it.
            Where the two do not fit on one line (French on a 320px phone), Mark all read's label
            wraps rather than push the page sideways. */}
        {show !== null ? (
          <div className="flex min-h-[30px] items-center gap-2">
            <Segmented
              label={t('show')}
              options={SHOWS}
              value={show}
              render={(option) => t(option === 'unread' ? 'showUnread' : 'showAll')}
              onChoose={(option) => onShow?.(option)}
              testId="list-show"
              tall
            />
            <span className="flex-1" />
            {markable ? (
              <button
                type="button"
                onClick={markAllRead}
                className="rounded-md px-2 py-1 text-right text-[13px] text-muted hover:bg-hover hover:text-ink group-data-[open=1]:hidden max-md:min-h-11"
                data-testid="mark-all-read"
              >
                {t('markAllRead')}
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
      {items.length === 0 && !caughtUp ? (
        <div className="px-6 py-10 text-[13.5px] text-muted" data-testid="list-empty">
          {pendingFetch ? (
            <p>{t('fetching')}</p>
          ) : (
            <>
              <p>{t('empty')}</p>
              <p>
                {t.rich('emptyHint', {
                  add: (chunks) => <Link to="/add">{chunks}</Link>,
                })}
              </p>
            </>
          )}
        </div>
      ) : null}
      <div className="flex flex-col px-3 pb-10">
        {items.length === 0 && caughtUp ? (
          // Unread leaves nothing (Tela v5, Tela Mobile 18): one press back to every post.
          <div
            className="flex flex-col items-center gap-3.5 border-t border-line px-2.5 py-14 text-center max-md:py-16"
            data-testid="list-caught-up"
          >
            <p className="m-0 font-serif text-[22px] text-ink">{t('caughtUp')}</p>
            <button
              type="button"
              onClick={() => onShow?.('all')}
              className="rounded-full border border-thumb px-3.5 py-1.5 text-[13px] font-medium text-ink hover:bg-hover max-md:min-h-11 max-md:px-[18px] max-md:text-sm"
              data-testid="show-all"
            >
              {t('showAllPosts')}
            </button>
          </div>
        ) : null}
        {shown.map((a) => {
          const active = a.id === params.articleId
          // The open post counts as read before its markRead lands, unless the member marks
          // posts read themselves: then it is unread until they do, and its dot says so. Nor
          // once the member marks it unread while it is open: opening read it, and that later
          // choice stands until the next open reads it again.
          const read = shownRead(tables, a, now, active, markOnOpen)
          const { title: rowTitle, excerpt, badge } = shownTitle(tables, a, readingLang, never)
          const name = feedTitle(tables, a.feedId)
          // No mode in the href: the remembered mode is the one an open should use (ADR 0017).
          const href = readingHref({
            filter: params.filter,
            feedId: params.feedId,
            articleId: a.id,
          })
          return (
            <Link
              key={a.id}
              to={href}
              onClick={(e) => {
                // Re-opening the article already open is not a navigation: no history entry for a
                // state the reader is already in.
                if (
                  canonicalReadingHref(location.search, { mode: null }) ===
                  canonicalReadingHref(new URL(href, 'http://x').search, { mode: null })
                ) {
                  e.preventDefault()
                }
              }}
              className="relative flex flex-col gap-1.5 rounded-lg border-t border-line px-2.5 py-3.5 text-ink hover:bg-hover hover:no-underline data-[active=1]:bg-surface"
              data-testid="article-row"
              data-article-id={a.id}
              data-read={read ? '1' : '0'}
              data-active={active ? '1' : undefined}
            >
              <div className="flex min-w-0 items-center gap-2 text-xs text-muted">
                <Swatch id={a.feedId} title={name} size={10} />
                <span className="min-w-0 flex-1 truncate font-medium text-ink">{name}</span>
                <span className="contents group-data-[open=1]:hidden">
                  <span>·</span>
                  <span className="whitespace-nowrap">
                    {relativeTime(a.publishedAt ?? a.fetchedAt, locale, now)}
                  </span>
                  {badge ? (
                    <span className="whitespace-nowrap rounded border border-line px-1.5 text-[10.5px]">
                      {t('translatedBadge', {
                        from: languageBadge(a.sourceLang ?? ''),
                        to: target,
                      })}
                    </span>
                  ) : null}
                </span>
                {badge ? (
                  <span className="hidden shrink-0 text-[10.5px] group-data-[open=1]:inline">
                    {languageBadge(a.sourceLang ?? '')}
                  </span>
                ) : null}
                {!read ? (
                  <span
                    className="size-[7px] shrink-0 rounded-full bg-accent"
                    data-testid="unread-dot"
                  />
                ) : null}
              </div>
              <h2
                data-row-title
                className="m-0 font-serif font-medium leading-[1.2] tracking-tight text-[19px] group-data-[open=1]:text-[15.5px]"
                style={{ textWrap: 'pretty' }}
              >
                {rowTitle}
              </h2>
              {excerpt ? (
                <p className="m-0 line-clamp-2 font-serif text-base leading-[1.4] text-ink-2 group-data-[open=1]:hidden">
                  {excerpt}
                </p>
              ) : null}
              <div className="flex gap-3 text-xs text-muted group-data-[open=1]:hidden">
                <span>{t('minutes', { n: a.readingMinutes || 1 })}</span>
                <GlyphCount kind="likeCount" n={a.likeCount} />
                <GlyphCount kind="recommendCount" n={a.recommendCount} />
              </div>
            </Link>
          )
        })}
        {items.length > shown.length ? (
          <button
            type="button"
            onClick={() => setLimit((n) => n + PAGE)}
            className="mt-3 rounded-lg border border-line px-3 py-2 text-[13px] text-muted hover:bg-hover hover:text-ink"
            data-testid="load-more"
          >
            {t('loadMore')}
          </button>
        ) : null}
      </div>
    </section>
  )
}

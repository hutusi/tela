import { languageBadge, type ReadingLanguage } from '@tela/shared'
import type { ArticleRow } from '@tela/sync'
import { useState } from 'react'
import { Link, useLocation } from 'react-router'
import { useTranslations } from 'use-intl'
import { relativeTime } from '../lib/format'
import { canonicalReadingHref, type ReadingParams, readingHref } from '../lib/href'
import { readingPrefsOf } from '../lib/prefs'
import { useStore, useTables } from '../store/hooks'
import { feedTitle, isMarkedUnread, isRead, shownTitle } from '../store/selectors'
import { Swatch } from './swatch'

type Props = {
  items: ArticleRow[]
  params: ReadingParams
  title?: string | undefined
  readingLang: ReadingLanguage
  locale: string
  now: number
  pendingFetch?: boolean
  /** Read posts are hidden (a pref), and they are all there is: say so, not "no posts". */
  hidingRead?: boolean
}

/** How many rows render; older ones follow on request. The device holds the whole horizon. */
const PAGE = 200

export function ArticleList({
  items,
  params,
  title,
  readingLang,
  locale,
  now,
  pendingFetch = false,
  hidingRead = false,
}: Props) {
  const t = useTranslations('list')
  const ts = useTranslations('sidebar')
  const tables = useTables()
  const { store } = useStore()
  const location = useLocation()
  const heading = title ?? ts(params.filter)
  const { markOnOpen, never } = readingPrefsOf(tables)
  const target = languageBadge(readingLang)
  const [limit, setLimit] = useState(PAGE)
  const shown = items.slice(0, limit)
  const markAllRead = () => {
    // Up to what the list displayed, never the server's newest: a post that arrived after the
    // reader looked stays unread (ADR 0025).
    const upTo = shown.reduce((max, a) => (a.id > max ? a.id : max), 0)
    if (upTo > 0) {
      store.mutate({
        type: 'markAllRead',
        upTo,
        ...(params.feedId ? { feedId: params.feedId } : {}),
      })
    }
  }
  return (
    <section
      className="min-w-0 border-r border-line group-data-[open=1]:hidden lg:sticky lg:top-14 lg:h-[calc(100vh-56px)] lg:overflow-y-auto lg:group-data-[open=1]:block"
      data-testid="article-list"
    >
      <div className="sticky top-0 z-[1] flex items-baseline gap-2 bg-paper px-5 pb-2.5 pt-5">
        <h1 className="min-w-0 flex-1 truncate font-serif font-medium tracking-tight text-[26px] group-data-[open=1]:text-[20px]">
          {heading}
        </h1>
        {items.length > 0 ? (
          <button
            type="button"
            onClick={markAllRead}
            className="whitespace-nowrap rounded-md px-2 py-1 text-[13px] text-muted hover:bg-hover hover:text-ink group-data-[open=1]:hidden"
            data-testid="mark-all-read"
          >
            {t('markAllRead')}
          </button>
        ) : null}
      </div>
      {items.length === 0 ? (
        <div className="px-6 py-10 text-[13.5px] text-muted" data-testid="list-empty">
          {pendingFetch ? (
            <p>{t('fetching')}</p>
          ) : hidingRead ? (
            <>
              <p>{t('allRead')}</p>
              <p>
                {t.rich('allReadHint', {
                  settings: (chunks) => <Link to="/settings/reading">{chunks}</Link>,
                })}
              </p>
            </>
          ) : (
            <>
              <p>{t('empty')}</p>
              <p>{t('emptyHint')}</p>
            </>
          )}
        </div>
      ) : null}
      <div className="flex flex-col px-3 pb-10">
        {shown.map((a) => {
          const active = a.id === params.articleId
          // The open post counts as read before its markRead lands, unless the member marks
          // posts read themselves: then it is unread until they do, and its dot says so. Nor
          // once the member marks it unread while it is open: opening read it, and that later
          // choice stands until the next open reads it again.
          const read =
            isRead(tables, a, now) || (active && markOnOpen && !isMarkedUnread(tables, a.id))
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
                <span>♡ {a.likeCount}</span>
                <span>↗ {a.recommendCount}</span>
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

import type { ArticleListItem } from '@tela/db/queries'
import { languageBadge } from '@tela/shared'
import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import { markAllReadAction } from '@/app/reading/actions'
import { type ReadingParams, readingHref } from '@/app/reading/href'
import { relativeTime } from '@/lib/format'
import { Swatch } from './swatch'

type Props = {
  items: ArticleListItem[]
  params: ReadingParams
  title?: string | undefined
  readingLang: string
  locale: string
  wide: boolean
  pendingFetch?: boolean
  className?: string
}

function foreign(sourceLang: string | null, locale: string): boolean {
  if (!sourceLang) return false
  return sourceLang.split('-')[0] !== locale.split('-')[0]
}

export async function ArticleList({
  items,
  params,
  title,
  readingLang,
  locale,
  wide,
  pendingFetch = false,
  className = '',
}: Props) {
  const t = await getTranslations('list')
  const ts = await getTranslations('sidebar')
  const heading = title ?? ts(params.filter)
  const target = languageBadge(readingLang)
  return (
    <section
      className={`min-w-0 border-r border-line lg:sticky lg:top-14 lg:h-[calc(100vh-56px)] lg:overflow-y-auto ${className}`}
      data-testid="article-list"
    >
      <div className="sticky top-0 z-[1] flex items-baseline justify-between bg-paper px-5 pb-2.5 pt-5">
        <h1
          className={`truncate font-serif font-medium tracking-tight ${wide ? 'text-[26px]' : 'text-[20px]'}`}
        >
          {heading}
        </h1>
        {wide && items.length > 0 ? (
          <form action={markAllReadAction}>
            {params.feedId ? <input type="hidden" name="feedId" value={params.feedId} /> : null}
            <button
              type="submit"
              className="whitespace-nowrap rounded-md px-2 py-1 text-[13px] text-muted hover:bg-hover hover:text-ink"
              data-testid="mark-all-read"
            >
              {t('markAllRead')}
            </button>
          </form>
        ) : null}
      </div>
      {items.length === 0 ? (
        <div className="px-6 py-10 text-[13.5px] text-muted" data-testid="list-empty">
          {pendingFetch ? (
            <p>{t('fetching')}</p>
          ) : (
            <>
              <p>{t('empty')}</p>
              <p>{t('emptyHint')}</p>
            </>
          )}
        </div>
      ) : null}
      <div className="flex flex-col px-3 pb-10">
        {items.map((a) => {
          const active = a.id === params.articleId
          // Opening an article marks it read (MarkRead fires the action), and this render is the
          // one the reader sees. Showing the selected row as read here is what lets that action
          // stay fire-and-forget instead of costing a second render of the whole page.
          const read = a.isRead || active
          const showBadge = foreign(a.sourceLang, readingLang)
          const shownTitle = showBadge && a.translatedTitle ? a.translatedTitle : a.title
          const shownExcerpt = showBadge && a.translatedExcerpt ? a.translatedExcerpt : a.excerpt
          return (
            <Link
              key={a.id}
              href={readingHref({ ...params, articleId: a.id })}
              className={`flex flex-col gap-1.5 rounded-lg border-t border-line px-2.5 py-3.5 text-ink hover:bg-hover hover:no-underline ${active ? 'bg-white' : ''}`}
              style={{ opacity: a.isRead && !active ? 0.62 : 1 }}
              data-testid="article-row"
              data-read={read ? '1' : '0'}
            >
              <div className="flex min-w-0 items-center gap-2 text-xs text-muted">
                <Swatch id={a.feedId} title={a.feedTitle} size={10} />
                <span className="min-w-0 flex-1 truncate font-medium text-ink">{a.feedTitle}</span>
                {wide ? (
                  <>
                    <span>·</span>
                    <span className="whitespace-nowrap">
                      {relativeTime(a.publishedAt ?? a.fetchedAt, locale)}
                    </span>
                    {showBadge ? (
                      <span className="whitespace-nowrap rounded border border-line px-1.5 text-[10.5px]">
                        {t('translatedBadge', {
                          from: languageBadge(a.sourceLang ?? ''),
                          to: target,
                        })}
                      </span>
                    ) : null}
                  </>
                ) : showBadge ? (
                  <span className="shrink-0 text-[10.5px]">
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
                className={`m-0 font-serif font-medium leading-[1.2] tracking-tight ${wide ? 'text-[19px]' : 'text-[15.5px]'}`}
                style={{ textWrap: 'pretty' }}
              >
                {shownTitle}
              </h2>
              {wide && shownExcerpt ? (
                <p className="m-0 line-clamp-2 font-serif text-base leading-[1.4] text-ink-2">
                  {shownExcerpt}
                </p>
              ) : null}
              {wide ? (
                <div className="flex gap-3 text-xs text-muted">
                  <span>{t('minutes', { n: a.readingMinutes ?? 1 })}</span>
                  <span>♡ {a.likeCount}</span>
                  <span>↗ {a.recommendCount}</span>
                </div>
              ) : null}
            </Link>
          )
        })}
      </div>
    </section>
  )
}

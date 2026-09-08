import type {
  ArticleDetail,
  ArticleListItem,
  SubscriptionRow,
  UnreadTotals,
} from '@tela/db/queries'
import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import { ArticleList } from '@/components/article-list'
import { AutoRefresh } from '@/components/auto-refresh'
import { EmptyState } from '@/components/empty-state'
import { MobileNav } from '@/components/mobile-nav'
import { Reader } from '@/components/reader'
import { Sidebar } from '@/components/sidebar'
import { buildReaderData } from '@/lib/reader-data'
import type { ReadingParams } from './href'

export type ListData = {
  subscriptions: SubscriptionRow[]
  totals: UnreadTotals
  items: ArticleListItem[]
}

/**
 * Sidebar, article list and — when no article is open — the empty state.
 *
 * It takes the queries as a promise rather than running them, so the page can start every query
 * in one flight and still let each pane stream in on its own.
 */
export async function ListPanes({
  data,
  params,
  readingLang,
  locale,
  open,
}: {
  data: Promise<ListData>
  params: ReadingParams
  readingLang: string
  locale: string
  open: boolean
}) {
  const { subscriptions, totals, items } = await data
  const selected =
    params.feedId !== null ? subscriptions.find((s) => s.feedId === params.feedId) : undefined
  const listTitle = params.feedId !== null ? (selected?.title ?? '') : undefined
  const pendingFetch = selected !== undefined && selected.lastFetchedAt === null
  return (
    <>
      {pendingFetch ? <AutoRefresh /> : null}
      {open ? null : <MobileNav subscriptions={subscriptions} totals={totals} params={params} />}
      <Sidebar subscriptions={subscriptions} totals={totals} params={params} />
      <ArticleList
        items={items}
        params={params}
        title={listTitle}
        readingLang={readingLang}
        locale={locale}
        wide={!open}
        pendingFetch={pendingFetch}
        className={open ? 'hidden lg:block' : ''}
      />
      {open ? null : <EmptyState unread={totals.all} hasSubscriptions={subscriptions.length > 0} />}
    </>
  )
}

/** The article itself, built into the shape the client pane renders. */
export async function ReaderPane({
  data,
  params,
  readingLang,
}: {
  data: Promise<ArticleDetail | null>
  params: ReadingParams
  readingLang: string
}) {
  const article = await data
  // A link to an article that has since been dropped: say so rather than leaving the pane blank.
  if (!article) return <ArticleGone />
  return (
    <Reader
      data={await buildReaderData(article, readingLang)}
      readingLang={readingLang}
      params={params}
    />
  )
}

/** The pane for an article id that no longer resolves — a stale link, or a dropped post. */
async function ArticleGone() {
  const t = await getTranslations('reader')
  return (
    <main className="flex items-center justify-center p-10 text-muted" data-testid="article-gone">
      <div className="max-w-[280px] text-center text-[13.5px] leading-normal">
        <p className="m-0">{t('articleGone')}</p>
        <Link href="/reading" className="mt-3 inline-block underline">
          {t('close')}
        </Link>
      </div>
    </main>
  )
}

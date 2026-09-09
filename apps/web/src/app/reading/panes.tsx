import type { ArticleListItem, SubscriptionRow, UnreadTotals } from '@tela/db/queries'
import { ArticleList } from '@/components/article-list'
import { AutoRefresh } from '@/components/auto-refresh'
import { Sidebar } from '@/components/sidebar'
import type { ReadingParams } from './href'

export type ListData = {
  subscriptions: SubscriptionRow[]
  totals: UnreadTotals
  items: ArticleListItem[]
}

/**
 * Sidebar and article list.
 *
 * It takes the queries as a promise rather than running them, so the page can start every query in
 * one flight and still let each pane stream in on its own. Whether an article is open is no longer
 * its business: that is client state now (see `ReadingShell`), and the open/closed presentation is
 * driven by `data-open` on the grid rather than by re-rendering this on every click.
 */
export async function ListPanes({
  data,
  params,
  readingLang,
  locale,
}: {
  data: Promise<ListData>
  params: ReadingParams
  readingLang: string
  locale: string
}) {
  const { subscriptions, totals, items } = await data
  const selected =
    params.feedId !== null ? subscriptions.find((s) => s.feedId === params.feedId) : undefined
  const listTitle = params.feedId !== null ? (selected?.title ?? '') : undefined
  const pendingFetch = selected !== undefined && selected.lastFetchedAt === null
  return (
    <>
      {pendingFetch ? <AutoRefresh /> : null}
      <Sidebar subscriptions={subscriptions} totals={totals} params={params} />
      <ArticleList
        items={items}
        params={params}
        title={listTitle}
        readingLang={readingLang}
        locale={locale}
        pendingFetch={pendingFetch}
      />
    </>
  )
}

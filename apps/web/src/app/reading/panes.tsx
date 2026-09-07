import type {
  ArticleDetail,
  ArticleListItem,
  SubscriptionRow,
  UnreadTotals,
} from '@tela/db/queries'
import { wantsExtraction } from '@tela/ingest'
import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import { ArticleList } from '@/components/article-list'
import { AutoRefresh } from '@/components/auto-refresh'
import { EmptyState } from '@/components/empty-state'
import { MobileNav } from '@/components/mobile-nav'
import { Reader, type ReaderTranslation } from '@/components/reader'
import { Sidebar } from '@/components/sidebar'
import { renderArticleHtml } from '@/lib/article-html'
import type { ReadingParams } from './href'
import { articleRevision } from './revision'

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

/** The article itself: body, translation, and what it is still waiting on. */
export async function ReaderPane({
  data,
  params,
  readingLang,
  locale,
}: {
  data: Promise<ArticleDetail | null>
  params: ReadingParams
  readingLang: string
  locale: string
}) {
  const article = await data
  // A link to an article that has since been dropped: say so rather than leaving the pane blank.
  if (!article) return <ArticleGone />
  const html = await renderArticleHtml(article.html)
  const row = article.translation

  // Foreign article: the body translation for the reading language came back with the article.
  let translation: ReaderTranslation | null = null
  if (article.sourceLang && article.sourceLang !== readingLang) {
    const fresh = row !== null && row.contentHash === article.contentHash
    const state = row === null || !fresh || row.status === 'pending' ? 'none' : row.status
    translation = {
      targetLang: readingLang,
      state,
      failedBlocks: fresh ? row.failedBlocks : 0,
      html:
        fresh && row.html && (row.status === 'done' || row.status === 'partial')
          ? await renderArticleHtml(row.html)
          : null,
      title: row?.title ?? null,
    }
  }

  return (
    <Reader
      article={article}
      html={html}
      params={params}
      locale={locale}
      translation={translation}
      recommendation={article.recommendation}
      extracting={wantsExtraction(article)}
      readingLang={readingLang}
      revision={articleRevision(article)}
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

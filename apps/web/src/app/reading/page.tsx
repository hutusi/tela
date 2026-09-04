import {
  countTotals,
  getArticle,
  getArticleTranslation,
  listArticles,
  listSubscriptions,
} from '@tela/db/queries'
import { getLocale, getTranslations } from 'next-intl/server'
import { AppHeader } from '@/components/app-header'
import { ArticleList } from '@/components/article-list'
import { AutoRefresh } from '@/components/auto-refresh'
import { EmptyState } from '@/components/empty-state'
import { Reader, type ReaderTranslation } from '@/components/reader'
import { Sidebar } from '@/components/sidebar'
import { renderArticleHtml } from '@/lib/article-html'
import { requireUser } from '@/lib/auth'
import { getDb } from '@/lib/platform/db'
import { getReadingLang } from '@/lib/reading'
import { parseReadingParams } from './href'

export const dynamic = 'force-dynamic'

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> }

export async function generateMetadata() {
  const t = await getTranslations('nav')
  return { title: t('reading') }
}

export default async function ReadingPage({ searchParams }: Props) {
  const user = await requireUser('/reading')
  const params = parseReadingParams(await searchParams)
  const db = await getDb()
  const readingLang = await getReadingLang()
  const [subscriptions, totals, items, article, locale] = await Promise.all([
    listSubscriptions(db, user.id),
    countTotals(db, user.id),
    listArticles(db, user.id, {
      filter: params.filter,
      feedId: params.feedId,
      limit: 60,
      translateTo: readingLang,
    }),
    params.articleId ? getArticle(db, user.id, params.articleId) : Promise.resolve(null),
    getLocale(),
  ])
  const html = article ? await renderArticleHtml(article.html) : ''

  // Foreign article: look up the body translation state for the reading language.
  let translation: ReaderTranslation | null = null
  if (article && article.sourceLang && article.sourceLang !== readingLang) {
    const row = await getArticleTranslation(db, article.id, readingLang)
    const fresh = row !== null && row.contentHash === article.contentHash
    const state = row === null || !fresh || row.status === 'pending' ? 'none' : row.status
    translation = {
      targetLang: readingLang,
      state,
      failedBlocks: fresh ? (row?.failedBlockIds.length ?? 0) : 0,
      html: fresh && row?.html ? await renderArticleHtml(row.html) : null,
      title: row?.title ?? null,
    }
  }

  const open = article !== null
  const selected =
    params.feedId !== null ? subscriptions.find((s) => s.feedId === params.feedId) : undefined
  const listTitle = params.feedId !== null ? (selected?.title ?? '') : undefined
  const pendingFetch = selected !== undefined && selected.lastFetchedAt === null

  return (
    <>
      <AppHeader active="reading" />
      <div
        className={`grid flex-1 grid-cols-1 lg:min-h-0 ${
          open
            ? 'lg:grid-cols-[220px_260px_minmax(0,1fr)]'
            : 'lg:grid-cols-[220px_minmax(280px,380px)_minmax(0,1fr)]'
        }`}
        data-testid="reading-layout"
      >
        {pendingFetch ? <AutoRefresh /> : null}
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
        {article ? (
          <Reader
            article={article}
            html={html}
            params={params}
            locale={locale}
            translation={translation}
          />
        ) : (
          <EmptyState unread={totals.all} hasSubscriptions={subscriptions.length > 0} />
        )}
      </div>
    </>
  )
}

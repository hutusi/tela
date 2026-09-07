import {
  countTotals,
  EXTRACT_COOLDOWN_MINUTES,
  getArticle,
  listArticles,
  listSubscriptions,
  markExtractRequested,
  readingRevision,
} from '@tela/db/queries'
import { wantsExtraction } from '@tela/ingest'
import { getLocale, getTranslations } from 'next-intl/server'
import { AppHeader } from '@/components/app-header'
import { ArticleList } from '@/components/article-list'
import { AutoRefresh } from '@/components/auto-refresh'
import { EmptyState } from '@/components/empty-state'
import { MobileNav } from '@/components/mobile-nav'
import { Reader, type ReaderTranslation } from '@/components/reader'
import { Sidebar } from '@/components/sidebar'
import { renderArticleHtml } from '@/lib/article-html'
import { requireUser } from '@/lib/auth'
import { getDb } from '@/lib/platform/db'
import { waitUntil } from '@/lib/platform/wait-until'
import { enqueueArticleExtract } from '@/lib/queue'
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
  // The reading language comes from a cookie, so nothing here waits on the database to learn
  // which translations to join: the four queries below go out together, as one round trip to a
  // database that is a continent away from wherever this worker happens to be running.
  const [readingLang, locale] = await Promise.all([getReadingLang(), getLocale()])
  const [subscriptions, totals, items, article] = await Promise.all([
    listSubscriptions(db, user.id),
    countTotals(db, user.id),
    listArticles(db, user.id, {
      filter: params.filter,
      feedId: params.feedId,
      limit: 60,
      translateTo: readingLang,
    }),
    params.articleId
      ? getArticle(db, user.id, params.articleId, { translateTo: readingLang })
      : Promise.resolve(null),
  ])

  // A summary-only article gets its full text fetched when opened. The claim is a write and the
  // reader is not waiting on it, so it runs after the response: the job follows the row update
  // that wins a cooldown window, not the render, and the worker stamps the article on a final
  // outcome. `extractRequestedAt` is already in hand, so a request inside a window it cannot win
  // never reaches the database at all.
  const extracting = article !== null && wantsExtraction(article)
  const mayClaim =
    article !== null &&
    extracting &&
    (article.extractRequestedAt === null ||
      Date.now() - article.extractRequestedAt.getTime() > EXTRACT_COOLDOWN_MINUTES * 60_000)
  if (article && mayClaim) {
    const id = article.id
    await waitUntil(
      markExtractRequested(db, id).then((won) => (won ? enqueueArticleExtract(db, id) : undefined)),
    )
  }

  const html = article ? await renderArticleHtml(article.html) : ''
  const recommendation = article?.recommendation ?? null

  // Foreign article: the body translation for the reading language came back with the article.
  let translation: ReaderTranslation | null = null
  const translationRow = article?.translation ?? null
  if (article && article.sourceLang && article.sourceLang !== readingLang) {
    const row = translationRow
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

  // What the open article is waiting on, as one string. A tab polls the state endpoint for it
  // instead of re-rendering this whole page to find out whether anything moved.
  const revision =
    article === null
      ? ''
      : readingRevision({
          contentHash: article.contentHash,
          extractCheckedAt: article.extractCheckedAt,
          translation: translationRow
            ? { status: translationRow.status, contentHash: translationRow.contentHash }
            : null,
        })

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
        {article ? (
          <Reader
            article={article}
            html={html}
            params={params}
            locale={locale}
            translation={translation}
            recommendation={recommendation}
            extracting={extracting}
            readingLang={readingLang}
            revision={revision}
          />
        ) : (
          <EmptyState unread={totals.all} hasSubscriptions={subscriptions.length > 0} />
        )}
      </div>
    </>
  )
}

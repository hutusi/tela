import {
  countTotals,
  EXTRACT_COOLDOWN_MINUTES,
  getArticle,
  listArticles,
  listSubscriptions,
  markExtractRequested,
} from '@tela/db/queries'
import { wantsExtraction } from '@tela/ingest'
import { getLocale, getTranslations } from 'next-intl/server'
import { Suspense } from 'react'
import { requireUser } from '@/lib/auth'
import { getDb } from '@/lib/platform/db'
import { waitUntil } from '@/lib/platform/wait-until'
import { enqueueArticleExtract } from '@/lib/queue'
import { getReadingLang } from '@/lib/reading'
import { parseReadingParams } from './href'
import { ListPanes, ReaderPane } from './panes'
import { ListPanesSkeleton, ReaderPaneSkeleton } from './skeletons'

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
  // which translations to join.
  const [readingLang, locale] = await Promise.all([getReadingLang(), getLocale()])

  // Start every query, await none. They leave together — one round trip to a database that is a
  // continent away from wherever this worker is running — and each pane below renders as its own
  // answer lands, behind a Suspense boundary, so the header and the frame do not wait for either.
  const listData = Promise.all([
    listSubscriptions(db, user.id),
    countTotals(db, user.id),
    listArticles(db, user.id, {
      filter: params.filter,
      feedId: params.feedId,
      limit: 60,
      translateTo: readingLang,
    }),
  ]).then(([subscriptions, totals, items]) => ({ subscriptions, totals, items }))
  const articleData = params.articleId
    ? getArticle(db, user.id, params.articleId, { translateTo: readingLang })
    : Promise.resolve(null)

  // A summary-only article gets its full text fetched when opened. The claim is a write nobody is
  // waiting on, so it runs after the response: the job follows the row update that wins a cooldown
  // window, not the render, and the worker stamps the article on a final outcome.
  // `extract_requested_at` comes back with the article, so a request inside a window it cannot win
  // never reaches the database at all.
  await waitUntil(claimExtraction(articleData, db))

  const open = params.articleId !== null
  return (
    <div
      className={`grid flex-1 grid-cols-1 lg:min-h-0 ${
        open
          ? 'lg:grid-cols-[220px_260px_minmax(0,1fr)]'
          : 'lg:grid-cols-[220px_minmax(280px,380px)_minmax(0,1fr)]'
      }`}
      data-testid="reading-layout"
    >
      <Suspense fallback={<ListPanesSkeleton open={open} />}>
        <ListPanes
          data={listData}
          params={params}
          readingLang={readingLang}
          locale={locale}
          open={open}
        />
      </Suspense>
      {open ? (
        <Suspense fallback={<ReaderPaneSkeleton />}>
          <ReaderPane
            data={articleData}
            params={params}
            readingLang={readingLang}
            locale={locale}
          />
        </Suspense>
      ) : null}
    </div>
  )
}

/** Claim one extraction window for an opened summary-only article, or do nothing. */
async function claimExtraction(
  articleData: Promise<Awaited<ReturnType<typeof getArticle>>>,
  db: Awaited<ReturnType<typeof getDb>>,
): Promise<void> {
  const article = await articleData
  if (!article || !wantsExtraction(article)) return
  const requested = article.extractRequestedAt
  const cooled =
    requested === null || Date.now() - requested.getTime() > EXTRACT_COOLDOWN_MINUTES * 60_000
  if (!cooled) return
  if (await markExtractRequested(db, article.id)) await enqueueArticleExtract(db, article.id)
}

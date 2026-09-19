import { countTotals, getArticle, listArticles, listSubscriptions } from '@tela/db/queries'
import { cookies } from 'next/headers'
import { getLocale, getTranslations } from 'next-intl/server'
import { Suspense } from 'react'
import { EmptyState } from '@/components/empty-state'
import { MobileNav } from '@/components/mobile-nav'
import type { InitialReaderState } from '@/components/reader-data'
import { ReadingShell } from '@/components/reading-shell'
import { requireUser } from '@/lib/auth'
import { claimExtraction } from '@/lib/extraction'
import { getDb } from '@/lib/platform/db'
import { waitUntil } from '@/lib/platform/wait-until'
import { buildReaderData } from '@/lib/reader-data'
import { getReadingLang } from '@/lib/reading'
import { READING_MODE_COOKIE, readingModeFromCookie } from '@/lib/reading-mode-cookie'
import { parseReadingParams, type ReadingParams } from './href'
import { type ListData, ListPanes } from './panes'
import { ListPanesSkeleton } from './skeletons'

export const dynamic = 'force-dynamic'

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> }

export async function generateMetadata() {
  const t = await getTranslations('nav')
  return { title: t('reading') }
}

/** The empty third column, which needs the list's own numbers. */
async function EmptyPane({ data }: { data: Promise<ListData> }) {
  const { subscriptions, totals } = await data
  return <EmptyState unread={totals.all} hasSubscriptions={subscriptions.length > 0} />
}

/** The small-screen feed picker, which the shell drops once an article is open. */
async function MobileNavPane({ data, params }: { data: Promise<ListData>; params: ReadingParams }) {
  const { subscriptions, totals } = await data
  return <MobileNav subscriptions={subscriptions} totals={totals} params={params} />
}

export default async function ReadingPage({ searchParams }: Props) {
  const user = await requireUser('/reading')
  const raw = await searchParams
  // A URL with no article carries no mode — a display mode for no article means nothing — so
  // closing an article used to forget it. The cookie remembers it instead.
  //
  // Two readers of the mode, and they are asking different questions. `Reader` asks what this
  // view shows and takes it from the URL, so a link naming a mode governs the article it names.
  // Everything that decides where to go next — the shell's click handler, the rows' hrefs —
  // asks what this reader prefers, and only the cookie answers that: it is the one copy a
  // client-side toggle keeps current, and the one that cannot be set by someone else's link.
  const remembered = readingModeFromCookie((await cookies()).get(READING_MODE_COOKIE)?.value)
  const defaultMode = remembered ?? 'side'
  const params = parseReadingParams(raw)
  const db = await getDb()
  // The reading language comes from a cookie, so nothing here waits on the database to learn
  // which translations to join.
  const [readingLang, locale] = await Promise.all([getReadingLang(), getLocale()])

  // Both queries leave together — one round trip to a database a continent away.
  const listData: Promise<ListData> = Promise.all([
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

  // Only a direct link renders the pane here. Every click after that fetches it from
  // /api/reading/article, which costs a route handler rather than this whole page (ADR 0017).
  const article = await articleData
  await waitUntil(claimExtraction(article, db))
  const initial: InitialReaderState = article
    ? { kind: 'ready', data: await buildReaderData(article, readingLang) }
    : params.articleId === null
      ? { kind: 'empty' }
      : { kind: 'gone', articleId: params.articleId }

  return (
    <ReadingShell
      initial={initial}
      readingLang={readingLang}
      defaultMode={defaultMode}
      filter={params.filter}
      emptyState={
        <Suspense fallback={null}>
          <EmptyPane data={listData} />
        </Suspense>
      }
      mobileNav={
        <Suspense fallback={null}>
          <MobileNavPane data={listData} params={params} />
        </Suspense>
      }
    >
      <Suspense fallback={<ListPanesSkeleton />}>
        <ListPanes data={listData} params={params} readingLang={readingLang} locale={locale} />
      </Suspense>
    </ReadingShell>
  )
}

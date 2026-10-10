/**
 * Discover's four tabs (ADR 0044): This week, Articles, Blogs and Readers. Each reads one public
 * answer, the same for everyone, which the edge hands over for the first render; what is the
 * member's own (the blogs they read, whom they follow) is put on it here, from the device.
 */
import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react'
import { Navigate, useLocation, useSearchParams } from 'react-router'
import { useTranslations } from 'use-intl'
import {
  articlesVersion,
  fetchingMore,
  fetchMore,
  heldPages,
  subscribeArticles,
} from '../lib/articles-pages'
import {
  type ArticlesParams,
  articlesApiPath,
  blogsApiPath,
  type DiscoverTab,
  legacyDiscover,
  parseArticlesParams,
  parseBlogsParams,
  READERS_PATH,
  WEEK_PATH,
} from '../lib/discover-href'
import { composeWeek } from '../lib/discover-week'
import { useMemberControls } from '../lib/member'
import { suggestReaders } from '../lib/suggest-readers'
import { useTitle } from '../lib/title'
import { useFollowed, useHidden, useMine, useReading, useTopOnArrival } from '../lib/use-discover'
import { usePublic } from '../lib/use-public'
import { useNow, useStore } from '../store/hooks'
import { useUi } from '../ui'
import { DiscoverView } from '../views/discover'
import { articlesList, DiscoverArticlesView } from '../views/discover-articles'
import { DiscoverReadersView } from '../views/discover-readers'
import { DiscoverWeekView, WEEK_READERS } from '../views/discover-week'
import type { ArticlesData, DiscoverData, ReadersData, WeekData } from '../views/types'

/** "Articles · Discover"; This week is Discover itself. */
function useTabTitle(tab: DiscoverTab) {
  const t = useTranslations()
  const discover = t('nav.discover')
  useTitle(tab === 'week' ? discover : `${t(`discover.tabs.${tab}`)} · ${discover}`)
}

/** `/discover`: This week, or the Blogs page an address from before the tabs names. */
export function DiscoverHome() {
  const location = useLocation()
  const legacy = legacyDiscover(location.pathname, location.search)
  if (legacy) return <Navigate to={legacy} replace />
  return <WeekPage />
}

const EMPTY_WEEK: WeekData = {
  since: 0,
  recommended: [],
  edition: { span: 'latest', posts: [] },
  newBlogs: [],
  readers: [],
}

function WeekPage() {
  const loaded = usePublic<WeekData>(WEEK_PATH)
  const member = useMemberControls()
  const { store } = useStore()
  const { locale } = useUi()
  const now = useNow()
  const reading = useReading(locale)
  const hidden = useHidden()
  const mine = useMine(reading)
  const followed = useFollowed(member !== undefined)
  useTabTitle('week')
  useTopOnArrival('week')
  const data =
    loaded.status === 'ready' ? loaded.data : loaded.status === 'missing' ? EMPTY_WEEK : null
  const week = useMemo(() => (data ? composeWeek(data, hidden) : null), [data, hidden])
  const readers = useMemo(
    () => (data ? suggestReaders(data.readers, mine).slice(0, WEEK_READERS) : []),
    [data, mine],
  )
  // The people this page shows: a follow from here is named by them until the pull comes.
  useEffect(() => {
    store.rememberPeople(readers.map((s) => s.person))
  }, [readers, store])
  return (
    <DiscoverWeekView
      week={week}
      readers={readers}
      member={member}
      reading={reading}
      locale={locale}
      now={now}
      followed={followed}
    />
  )
}

/** Fewer posts than this left after the member's blogs: the page asks for more on its own. */
const FEW_POSTS = 12

/**
 * Articles' first page, and the pages "More" brought after it (`lib/articles-pages.ts`), which
 * live for the visit outside the page: this page hears every change to them, including a request
 * a page shown before it made.
 */
function useArticles(params: ArticlesParams) {
  const base = articlesApiPath(params)
  const loaded = usePublic<ArticlesData>(base)
  const first = loaded.status === 'ready' ? loaded.data : null
  useSyncExternalStore(subscribeArticles, articlesVersion, articlesVersion)
  const busy = fetchingMore(base)
  const held = heldPages(base)
  const extra = first && held && held.after === first.next ? held : null
  const pages = useMemo(() => (first ? [first, ...(extra?.pages ?? [])] : null), [first, extra])
  const next = pages ? (pages.at(-1)?.next ?? null) : null
  const more = useCallback(
    (from: string, auto: boolean) => {
      if (!first?.next) return
      const url = articlesApiPath({ ...params, cursor: from })
      void fetchMore({ base, start: first.next, from, auto, url })
    },
    [base, first, params],
  )
  return { loaded, pages, next, more, busy }
}

export function ArticlesPage() {
  const [search] = useSearchParams()
  // One object per address, so what depends on it changes only when the address does.
  const query = search.toString()
  // biome-ignore lint/correctness/useExhaustiveDependencies: the query string is the parameters
  const params = useMemo(() => parseArticlesParams(search), [query])
  const { loaded, pages, next, more, busy } = useArticles(params)
  const member = useMemberControls()
  const { locale } = useUi()
  const now = useNow()
  const reading = useReading(locale)
  const hidden = useHidden()
  const followed = useFollowed(member !== undefined)
  useTabTitle('articles')
  // A filter or the sort is chosen at the top; a cursor is a page of its own, reached by a link.
  useTopOnArrival(`articles:${params.cursor}`)
  const posts = useMemo(
    () =>
      pages ? articlesList(pages, params.sort, hidden) : loaded.status === 'missing' ? [] : null,
    [pages, params.sort, hidden, loaded.status],
  )
  // The member's blogs left too few to read on: ask for the next pages, a couple at most.
  const few = posts !== null && posts.length < FEW_POSTS
  useEffect(() => {
    if (few && next !== null && !busy) more(next, true)
  }, [few, next, busy, more])
  return (
    <DiscoverArticlesView
      posts={posts}
      languages={pages?.[0]?.languages ?? []}
      next={next}
      params={params}
      member={member}
      reading={reading}
      locale={locale}
      now={now}
      followed={followed}
      loadingMore={busy}
      onMore={(e) => {
        // A link without a script, more of this page with one: the address stays as it is. A
        // click meant for a new tab or window stays the link's.
        if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
        e.preventDefault()
        if (next !== null && !busy) more(next, false)
      }}
    />
  )
}

export function BlogsPage() {
  const [search] = useSearchParams()
  const params = parseBlogsParams(search)
  const loaded = usePublic<DiscoverData>(blogsApiPath(params))
  const member = useMemberControls()
  const { locale } = useUi()
  useTabTitle('blogs')
  // A page the pager opened starts at its top: one already held renders at once, deep in the
  // grid the browser kept the scroll of.
  useTopOnArrival(`blogs:${params.page}`)
  return (
    <DiscoverView
      data={
        loaded.status === 'ready'
          ? loaded.data
          : loaded.status === 'missing'
            ? { sites: [], languages: [] }
            : null
      }
      params={params}
      member={member}
      locale={locale}
    />
  )
}

export function ReadersPage() {
  const loaded = usePublic<ReadersData>(READERS_PATH)
  const member = useMemberControls()
  const { store } = useStore()
  const { locale } = useUi()
  const reading = useReading(locale)
  const mine = useMine(reading)
  useTabTitle('readers')
  useTopOnArrival('readers')
  const data = loaded.status === 'ready' ? loaded.data : null
  const missing = loaded.status === 'missing'
  const suggestions = useMemo(
    () => (data ? suggestReaders(data.readers, mine) : missing ? [] : null),
    [data, missing, mine],
  )
  useEffect(() => {
    if (suggestions) store.rememberPeople(suggestions.map((s) => s.person))
  }, [suggestions, store])
  return <DiscoverReadersView suggestions={suggestions} member={member} reading={reading} />
}

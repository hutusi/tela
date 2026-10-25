/**
 * Discover's Blogrolls tab, `/discover/blogrolls` (ADR 0050). One public answer, the same for
 * everyone, which the edge hands over for the first render (ADR 0044); what is the member's own
 * is put on it here, from the device: which blogrolls are theirs, and whose owners they follow,
 * taken once as the page opens. Their own blogrolls stay listed, marked "Yours", as the Blogs tab
 * keeps the blogs they read.
 */
import { useCallback, useMemo, useSyncExternalStore } from 'react'
import { useSearchParams } from 'react-router'
import { useTranslations } from 'use-intl'
import { blogrollsApiPath, blogrollsCursor } from '../lib/blogroll-href'
import {
  blogrollsList,
  blogrollsVersion,
  fetchingBlogrolls,
  fetchMoreBlogrolls,
  heldBlogrolls,
  subscribeBlogrolls,
} from '../lib/blogroll-pages'
import { useTitle } from '../lib/title'
import { useOpenedWith, useTopOnArrival } from '../lib/use-discover'
import { retryOf, usePublic } from '../lib/use-public'
import { useReadingLang } from '../store/hooks'
import { useUi } from '../ui'
import { type BlogrollReason, DiscoverBlogrollsView } from '../views/discover-blogrolls'
import type { BlogrollCard, BlogrollsData } from '../views/types'

/**
 * The first page, and the pages "More" brought after it (`lib/blogroll-pages.ts`), which live for
 * the visit outside the page: this page hears every change to them, including a request a page
 * shown before it made.
 */
function useBlogrolls(cursor: string | null) {
  const base = blogrollsApiPath(cursor)
  const loaded = usePublic<BlogrollsData>(base)
  const first = loaded.status === 'ready' ? loaded.data : null
  useSyncExternalStore(subscribeBlogrolls, blogrollsVersion, blogrollsVersion)
  const busy = fetchingBlogrolls(base)
  const held = heldBlogrolls(base)
  const extra = first && held && held.after === first.next ? held : null
  const pages = useMemo(() => (first ? [first, ...(extra?.pages ?? [])] : null), [first, extra])
  const next = pages ? (pages.at(-1)?.next ?? null) : null
  const more = useCallback(
    (from: string) => {
      if (!first?.next) return
      void fetchMoreBlogrolls({ base, start: first.next, from, url: blogrollsApiPath(from) })
    },
    [base, first],
  )
  return { loaded, pages, next, more, busy }
}

export function BlogrollsPage() {
  const [search] = useSearchParams()
  const cursor = blogrollsCursor(search)
  const { loaded, pages, next, more, busy } = useBlogrolls(cursor)
  const t = useTranslations()
  const hl = useReadingLang(useUi().locale)
  useTitle(`${t('discover.tabs.blogrolls')} · ${t('nav.discover')}`)
  // A cursor is a page of its own, reached by a link.
  useTopOnArrival(`blogrolls:${cursor}`)
  // Who the member is and whom they follow, as the page opened: a Follow elsewhere meanwhile
  // leaves the cards as they were until they come back (ADR 0044). Nothing for a visitor.
  const opened = useOpenedWith((tables, owner) => ({
    owner,
    follows: new Set(tables.follows.keys()) as ReadonlySet<string>,
  }))
  const reasonOf = useCallback(
    (card: BlogrollCard): BlogrollReason =>
      !opened
        ? null
        : card.owner.id === opened.owner
          ? 'yours'
          : opened.follows.has(card.owner.id)
            ? 'follows'
            : null,
    [opened],
  )
  const cards = useMemo(
    () => (pages ? blogrollsList(pages) : loaded.status === 'missing' ? [] : null),
    [pages, loaded.status],
  )
  return (
    <DiscoverBlogrollsView
      cards={cards}
      next={next}
      reasonOf={reasonOf}
      hl={hl}
      loadingMore={busy}
      onRetry={retryOf(loaded)}
      onMore={(e) => {
        // A link without a script, more of this page with one: the address stays as it is. A
        // click meant for a new tab or window stays the link's.
        if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
        e.preventDefault()
        if (next !== null && !busy) more(next)
      }}
    />
  )
}

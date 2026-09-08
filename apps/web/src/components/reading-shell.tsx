'use client'

import type { ArticleFilter } from '@tela/db/queries'
import { useTranslations } from 'next-intl'
import { useCallback, useEffect, useRef, useState } from 'react'
import { parseReadingArticleId, parseReadingMode } from '@/app/reading/href'
import { ReaderPaneSkeleton } from '@/app/reading/skeletons'
import { Reader } from './reader'
import type { InitialReaderState, ReaderData } from './reader-data'

type Props = {
  /** The pane the server rendered, when the URL arrived with an article on it. */
  initial: InitialReaderState
  readingLang: string
  filter: ArticleFilter
  /** Sidebar and article list, rendered on the server and passed straight through. */
  children: React.ReactNode
  /** Shown in the third column when no article is open. */
  emptyState: React.ReactNode
  /** The small-screen feed picker, which has no place once an article fills the screen. */
  mobileNav: React.ReactNode
}

/**
 * Owns which article is open.
 *
 * Clicking a row used to be a navigation, and a navigation is a React server render of the whole
 * three-pane page — about 67 ms of CPU against a 10 ms Workers Free budget, which is what produced
 * Error 1102 after a dozen or so articles (ADR 0017). Here the click fetches the pane's data from
 * a route handler instead, at around 20 ms, and the sidebar and list are never re-rendered at all.
 *
 * The rows stay real links: the click is intercepted, so middle-click, ctrl-click and "open in new
 * tab" keep working, the URL still follows through `pushState`, and back and forward still do what
 * they should.
 */
export function ReadingShell({
  initial,
  readingLang,
  filter,
  children,
  emptyState,
  mobileNav,
}: Props) {
  const t = useTranslations('reader')
  const [data, setData] = useState<ReaderData | null>(
    initial.kind === 'ready' ? initial.data : null,
  )
  const [gone, setGone] = useState(initial.kind === 'gone')
  const [loading, setLoading] = useState(false)
  // A real navigation still happens sometimes — a filter change, a router.refresh() after a like —
  // and React keeps this instance across it, so `useState(initial)` alone would hold the article
  // the page first mounted with. Adopt whatever the server just sent.
  const [servedInitial, setServedInitial] = useState(initial)
  if (servedInitial !== initial) {
    setServedInitial(initial)
    setData(initial.kind === 'ready' ? initial.data : null)
    setGone(initial.kind === 'gone')
    setLoading(false)
  }
  const listRef = useRef<HTMLDivElement>(null)
  const inFlight = useRef<AbortController | null>(null)

  // A server navigation or refresh has authoritative pane data. Stop any older endpoint request
  // from competing with it; `load` also checks the live URL before accepting a response.
  useEffect(() => {
    inFlight.current?.abort(new DOMException(`server state: ${initial.kind}`, 'AbortError'))
    inFlight.current = null
  }, [initial])

  /**
   * The list is server-rendered and never re-renders here, so the selected row is marked in the
   * DOM. The unread dot is removed rather than hidden: it is gone from the reader's model of the
   * page, and the next navigation re-renders the list from the truth anyway.
   */
  const markRow = useCallback((articleId: number | null) => {
    const root = listRef.current
    if (!root) return
    for (const a of root.querySelectorAll<HTMLElement>('[data-testid="article-row"]')) {
      const id = Number(
        new URL(a.getAttribute('href') ?? '', location.origin).searchParams.get('article'),
      )
      const active = id === articleId
      if (active) {
        a.dataset.active = '1'
        a.dataset.read = '1'
        a.querySelector('[data-testid="unread-dot"]')?.remove()
      } else {
        delete a.dataset.active
      }
    }
  }, [])

  const load = useCallback(
    async (articleId: number | null, options: { silent?: boolean } = {}) => {
      inFlight.current?.abort()
      markRow(articleId)
      if (articleId === null) {
        setData(null)
        setGone(false)
        setLoading(false)
        return
      }
      const controller = new AbortController()
      inFlight.current = controller
      if (!options.silent) setLoading(true)
      setGone(false)
      try {
        const url = `/api/reading/article?article=${articleId}&lang=${encodeURIComponent(readingLang)}`
        const res = await fetch(url, { signal: controller.signal, cache: 'no-store' })
        // A navigation may have replaced this request while it was in flight. The URL owns which
        // article is open, so a late response must never put the old one back.
        const currentId = parseReadingArticleId(new URLSearchParams(location.search).get('article'))
        if (controller.signal.aborted || currentId !== articleId) return
        // A link to an article that has since been dropped: say so rather than navigating into a
        // page that would only find the same nothing.
        if (res.status === 404) {
          setData(null)
          setGone(true)
          return
        }
        if (!res.ok) throw new Error(`reader ${res.status}`)
        setData((await res.json()) as ReaderData)
      } catch (err) {
        if ((err as Error).name === 'AbortError') return
        const currentId = parseReadingArticleId(new URLSearchParams(location.search).get('article'))
        if (currentId !== articleId) return
        // Fall back to a real navigation: the server renders the pane, slowly but correctly.
        window.location.reload()
        return
      } finally {
        if (!controller.signal.aborted && !options.silent) setLoading(false)
      }
    },
    [markRow, readingLang],
  )

  // A click on an article row, anywhere in the list.
  const onClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (event.defaultPrevented || event.button !== 0) return
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
      const link = (event.target as HTMLElement).closest<HTMLAnchorElement>(
        'a[data-testid="article-row"]',
      )
      if (!link) return
      const href = new URL(link.href, location.origin)
      const id = Number(href.searchParams.get('article'))
      if (!Number.isInteger(id) || id <= 0) return
      // The anchors carry the mode from their server render. Mode changes do not render the
      // server, so carry the live URL value forward when opening the next article.
      const mode = parseReadingMode(new URLSearchParams(location.search).get('mode'))
      if (mode === 'side') href.searchParams.delete('mode')
      else href.searchParams.set('mode', mode)
      event.preventDefault()
      window.history.pushState(null, '', href)
      void load(id)
    },
    [load],
  )

  /** Re-fetch the open pane in place, without the skeleton: a background job has moved it on. */
  const reload = useCallback(() => {
    const id = data?.article.id
    if (id !== undefined) void load(id, { silent: true })
  }, [data, load])

  const close = useCallback(() => {
    const url = new URL(window.location.href)
    url.searchParams.delete('article')
    url.searchParams.delete('mode')
    window.history.pushState(null, '', url)
    void load(null)
  }, [load])

  // Back and forward move between articles without touching the server for anything but the pane.
  useEffect(() => {
    const onPop = () => {
      const id = parseReadingArticleId(new URLSearchParams(window.location.search).get('article'))
      void load(id)
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [load])

  useEffect(() => {
    markRow(data?.article.id ?? null)
  }, [markRow, data])

  const open = data !== null || loading || gone
  return (
    <div
      className={`group grid flex-1 grid-cols-1 lg:min-h-0 ${
        open
          ? 'lg:grid-cols-[220px_260px_minmax(0,1fr)]'
          : 'lg:grid-cols-[220px_minmax(280px,380px)_minmax(0,1fr)]'
      }`}
      data-testid="reading-layout"
      data-open={open ? '1' : undefined}
    >
      {open ? null : mobileNav}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: the rows are real links; this only intercepts */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: same */}
      <div ref={listRef} onClick={onClick} className="contents">
        {children}
      </div>
      {data ? (
        <Reader
          key={data.article.id}
          data={data}
          readingLang={readingLang}
          filter={filter}
          onClose={close}
          onReload={reload}
        />
      ) : loading ? (
        <ReaderPaneSkeleton />
      ) : gone ? (
        <main
          className="flex items-center justify-center p-10 text-muted"
          data-testid="article-gone"
        >
          <div className="max-w-[280px] text-center text-[13.5px] leading-normal">
            <p className="m-0">{t('articleGone')}</p>
            <button type="button" onClick={close} className="mt-3 underline">
              {t('close')}
            </button>
          </div>
        </main>
      ) : (
        emptyState
      )}
    </div>
  )
}

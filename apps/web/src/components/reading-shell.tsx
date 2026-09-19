'use client'

import type { ArticleFilter } from '@tela/db/queries'
import { useTranslations } from 'next-intl'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  canonicalReadingHref,
  parseReadingArticleId,
  type ReadingMode,
  readingModeParam,
} from '@/app/reading/href'
import { ReaderPaneSkeleton } from '@/app/reading/skeletons'
import { type PaneState, reconcile, type ServerState } from '@/lib/reader-navigation'
import { readingModeDocumentCookie } from '@/lib/reading-mode-cookie'
import { Reader } from './reader'
import type { InitialReaderState, ReaderData } from './reader-data'

type Props = {
  /** What the server rendered for the URL it was given. */
  initial: InitialReaderState
  readingLang: string
  /** The mode a URL with no `mode` means: what this reader last chose, from the cookie. */
  defaultMode: ReadingMode
  filter: ArticleFilter
  /** Sidebar and article list, rendered on the server and passed straight through. */
  children: React.ReactNode
  /** Shown in the third column when no article is open. */
  emptyState: React.ReactNode
  /** The small-screen feed picker, which has no place once an article fills the screen. */
  mobileNav: React.ReactNode
}

/** The pane, as one value rather than three flags that can disagree. */
type Pane =
  | { kind: 'empty' }
  | { kind: 'loading'; articleId: number }
  | { kind: 'ready'; articleId: number; data: ReaderData }
  | { kind: 'gone'; articleId: number }

function paneFromServer(initial: InitialReaderState): Pane {
  if (initial.kind === 'ready') {
    return { kind: 'ready', articleId: initial.data.article.id, data: initial.data }
  }
  if (initial.kind === 'gone') return { kind: 'gone', articleId: initial.articleId }
  return { kind: 'empty' }
}

function serverState(initial: InitialReaderState): ServerState {
  return initial.kind === 'ready' ? { kind: 'ready', articleId: initial.data.article.id } : initial
}

function paneState(pane: Pane): PaneState {
  return pane.kind === 'ready' ? { kind: 'ready', articleId: pane.articleId } : pane
}

function currentUrlArticleId(): number | null {
  return parseReadingArticleId(new URLSearchParams(window.location.search).get('article'))
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
 *
 * Every trigger — mount, a server render, a click, Back — does the same two things: move the URL,
 * then ask `reconcile` what the pane owes it. Deciding that inline, per trigger, is what kept
 * getting it wrong.
 */
export function ReadingShell({
  initial,
  readingLang,
  defaultMode: serverMode,
  filter,
  children,
  emptyState,
  mobileNav,
}: Props) {
  const t = useTranslations('reader')
  const [pane, setPane] = useState<Pane>(() => paneFromServer(initial))
  /**
   * Held in state, not read from the prop, because a mode change never renders the server.
   * Choosing "side by side" deletes the param, so the next article would otherwise open in
   * whatever default this page was rendered with — the one the reader just moved away from.
   */
  const [defaultMode, setDefaultMode] = useState<ReadingMode>(serverMode)
  /** Bumped whenever the URL moves under us, which React has no way to observe. */
  const [urlMoved, setUrlMoved] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)
  const inFlight = useRef<AbortController | null>(null)
  const lastServer = useRef<InitialReaderState>(initial)

  const load = useCallback(
    async (articleId: number, options: { silent?: boolean } = {}) => {
      inFlight.current?.abort()
      const controller = new AbortController()
      inFlight.current = controller
      if (!options.silent) setPane({ kind: 'loading', articleId })
      try {
        const url = `/api/reading/article?article=${articleId}&lang=${encodeURIComponent(readingLang)}`
        const res = await fetch(url, { signal: controller.signal, cache: 'no-store' })
        // A navigation may have replaced this request while it was in flight. The URL owns which
        // article is open, so a late response must never put the old one back.
        if (controller.signal.aborted || currentUrlArticleId() !== articleId) return
        // A link to an article that has since been dropped: say so rather than navigating into a
        // page that would only find the same nothing.
        if (res.status === 404) {
          setPane({ kind: 'gone', articleId })
          return
        }
        if (!res.ok) throw new Error(`reader ${res.status}`)
        const data = (await res.json()) as ReaderData
        if (controller.signal.aborted || currentUrlArticleId() !== articleId) return
        setPane({ kind: 'ready', articleId, data })
      } catch (err) {
        if ((err as Error).name === 'AbortError') return
        if (currentUrlArticleId() !== articleId) return
        // Fall back to a real navigation: the server renders the pane, slowly but correctly.
        window.location.reload()
      }
    },
    [readingLang],
  )

  /**
   * The one place that decides what the pane should be showing.
   *
   * It runs on mount, on every server render, and whenever the URL moves. The URL is authoritative
   * (ADR 0017): a server state that disagrees with it — which is exactly what Next replays when
   * you press Back onto an entry written by `pushState` — is overruled rather than adopted.
   */
  // The URL is read fresh inside; bumping urlMoved is how a pushState or a popstate — neither of
  // which React can observe — asks this to run again.
  // biome-ignore lint/correctness/useExhaustiveDependencies: urlMoved is a trigger, not a value
  useEffect(() => {
    const serverChanged = lastServer.current !== initial
    lastServer.current = initial
    const action = reconcile({
      urlArticleId: currentUrlArticleId(),
      server: serverState(initial),
      serverChanged,
      pane: paneState(pane),
    })
    switch (action.do) {
      case 'nothing':
        return
      case 'clear':
        inFlight.current?.abort()
        setPane({ kind: 'empty' })
        return
      case 'adopt':
        inFlight.current?.abort()
        setPane(paneFromServer(initial))
        return
      case 'fetch':
        void load(action.articleId)
        return
    }
  }, [initial, pane, load, urlMoved])

  /**
   * The list is server-rendered and never re-renders here, so the selected row is marked in the
   * DOM. The unread dot is removed rather than hidden: it is gone from the reader's model of the
   * page, and the next navigation re-renders the list from the truth anyway.
   */
  const openId = pane.kind === 'empty' ? null : pane.articleId
  const readyId = pane.kind === 'ready' ? pane.articleId : null

  /**
   * Start a new article at its beginning.
   *
   * A real navigation scrolled to the top; `pushState` does not, so opening a second article while
   * halfway down the first one left it opening mid-page with its title above the fold. This fires
   * as soon as the article is asked for, so the jump happens with the skeleton rather than after
   * the body lands. Keyed on the article, so a silent re-fetch after a background job does not
   * yank the reader back to the top of what they are already reading.
   */
  useEffect(() => {
    if (openId === null) return
    window.scrollTo({ top: 0 })
  }, [openId])

  /**
   * And move focus into it, which a navigation also used to do.
   *
   * Separately from the scroll, and keyed on the article being *ready*: while it is loading the
   * pane is a skeleton, so there is nothing to focus, and the id does not change again when the
   * body arrives — so doing both together meant focus was never moved at all.
   */
  useEffect(() => {
    if (readyId === null) return
    document.querySelector<HTMLElement>('[data-testid="reader"]')?.focus({ preventScroll: true })
  }, [readyId])

  useEffect(() => {
    const root = listRef.current
    if (!root) return
    for (const a of root.querySelectorAll<HTMLElement>('[data-testid="article-row"]')) {
      const id = parseReadingArticleId(
        new URL(a.getAttribute('href') ?? '', location.origin).searchParams.get('article'),
      )
      if (id === openId) {
        a.dataset.active = '1'
        a.dataset.read = '1'
        a.querySelector('[data-testid="unread-dot"]')?.remove()
      } else {
        delete a.dataset.active
      }
    }
  }, [openId])

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
      if (parseReadingArticleId(href.searchParams.get('article')) === null) return
      event.preventDefault()
      // The anchors carry the mode from their server render. Mode changes do not render the server,
      // so carry the live URL value forward when opening the next article, and the remembered
      // default when the URL is silent — which it is whenever no article is open.
      const mode = readingModeParam(new URLSearchParams(location.search).get('mode')) ?? defaultMode
      const target = canonicalReadingHref(href.search, { mode })
      // Both sides through the same canonical form: `?mode=side&article=1` and `?article=1` are the
      // same place, and comparing them as text stacked a history entry for a state the reader was
      // already in, so the next Back appeared to do nothing.
      if (target === canonicalReadingHref(location.search)) return
      window.history.pushState(null, '', target)
      setUrlMoved((n) => n + 1)
    },
    [defaultMode],
  )

  /** Remember the reader's choice for the next article they open, without a server round trip. */
  const onModeChange = useCallback((next: ReadingMode) => {
    setDefaultMode(next)
    // biome-ignore lint/suspicious/noDocumentCookie: Cookie Store is not available in every browser Tela supports.
    document.cookie = readingModeDocumentCookie(next)
  }, [])

  /** Re-fetch the open pane in place, without the skeleton: a background job has moved it on. */
  const reload = useCallback(() => {
    if (pane.kind === 'ready') void load(pane.articleId, { silent: true })
  }, [pane, load])

  const close = useCallback(() => {
    const target = canonicalReadingHref(window.location.search, { articleId: null })
    if (target === canonicalReadingHref(window.location.search)) return
    window.history.pushState(null, '', target)
    setUrlMoved((n) => n + 1)
  }, [])

  // Back and forward move between articles without touching the server for anything but the pane.
  useEffect(() => {
    const onPop = () => setUrlMoved((n) => n + 1)
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  const open = pane.kind !== 'empty'
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
      {pane.kind === 'ready' ? (
        <Reader
          key={pane.articleId}
          data={pane.data}
          readingLang={readingLang}
          defaultMode={defaultMode}
          filter={filter}
          onClose={close}
          onReload={reload}
          onModeChange={onModeChange}
        />
      ) : pane.kind === 'loading' ? (
        <ReaderPaneSkeleton />
      ) : pane.kind === 'gone' ? (
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

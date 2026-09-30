/**
 * `/reading`: sidebar, list, and the open article. The URL is the one owner of what is open
 * (ADR 0017's rule, kept), and every pane is a function of it and the local store, so a click, a
 * filter change or Back is a render, not a request (ADR 0025).
 */
import { translationKey } from '@tela/sync'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate, useNavigationType, useSearchParams } from 'react-router'
import { useTranslations } from 'use-intl'
import { ArticleList } from '../components/article-list'
import { EmptyState } from '../components/empty-state'
import { MobileNav } from '../components/mobile-nav'
import { Reader } from '../components/reader'
import { Shortcuts } from '../components/shortcuts'
import { Sidebar } from '../components/sidebar'
import { SidebarRail } from '../components/sidebar-rail'
import { toggleSidebarKeepingFocus } from '../components/sidebar-toggle'
import { ReaderPaneSkeleton } from '../components/skeletons'
import {
  canonicalReadingHref,
  parseReadingParams,
  type ReadingMode,
  readingHref,
} from '../lib/href'
import { gridColumns, toggleFocus, useLayout } from '../lib/layout'
import { PREF_KEYS, useReadingPrefs } from '../lib/prefs'
import { useNow, useReadingLang, useStore, useTables } from '../store/hooks'
import {
  articlesFor,
  isLiked,
  isRead,
  shownTitle,
  subscriptionItems,
  totals,
} from '../store/selectors'
import { useUi } from '../ui'

/** While a new feed waits for its first fetch, pull this often so its posts appear. */
const FIRST_FETCH_PULL_MS = 3000
const PREFETCH_IDLE_MS = 1500

export function ReadingPage() {
  const t = useTranslations('reader')
  const tables = useTables()
  const now = useNow()
  const { locale } = useUi()
  const readingLang = useReadingLang(locale)
  const { store, objects, engine } = useStore()
  const [search] = useSearchParams()
  const location = useLocation()
  const navigate = useNavigate()
  const params = parseReadingParams(search)

  const subs = subscriptionItems(tables, now)
  const counts = totals(tables, now)
  const prefs = useReadingPrefs(tables)
  const all = articlesFor(tables, params, now)
  // Hiding read posts (a pref) must not pull a post out from under the reader: what was unread
  // when this list was entered stays in it until the reader moves to another list, so opening a
  // post, or j and k, never lose their place. Posts arriving later join it unread.
  const listKey = `${params.filter}:${params.feedId}`
  const enteredUnread = useRef<{ key: string; ids: ReadonlySet<number> } | null>(null)
  if (prefs.hideRead && enteredUnread.current?.key !== listKey) {
    enteredUnread.current = {
      key: listKey,
      ids: new Set(all.filter((a) => !isRead(tables, a, now)).map((a) => a.id)),
    }
  }
  const kept = enteredUnread.current?.ids
  const items = useMemo(
    () =>
      prefs.hideRead
        ? all.filter(
            (a) =>
              a.id === params.articleId ||
              kept?.has(a.id) ||
              !isRead(tables, a, now) ||
              isLiked(tables, a.id),
          )
        : all,
    [all, prefs.hideRead, kept, tables, now, params.articleId],
  )
  const selected = params.feedId !== null ? subs.find((s) => s.feedId === params.feedId) : undefined
  const listTitle = params.feedId !== null ? (selected?.title ?? '') : undefined
  const pendingFetch = selected !== undefined && selected.lastFetchedAt === null
  const article =
    params.articleId !== null ? (store.article(tables, params.articleId) ?? null) : null
  const open = params.articleId !== null
  // Which panes show beside the article: this device's choice, not the member's (ADR 0029). In
  // focus an open article has the page to itself; a closed one shows the list as ever.
  const panes = useLayout()
  const focused = open && panes.focus === 'on'

  // The post after this one in the list as shown, the one `j` would open: a card at the end of
  // the article offers it, so a pointer reader flows on without going back up to the list.
  const at = article ? items.findIndex((a) => a.id === article.id) : -1
  const after = at === -1 ? undefined : items[at + 1]
  const next = after
    ? {
        href: readingHref({ filter: params.filter, feedId: params.feedId, articleId: after.id }),
        title: shownTitle(tables, after, readingLang, prefs.never).title,
      }
    : null

  // The mode a URL without one means: this member's last choice, synced like any other pref.
  const mode = params.mode ?? prefs.mode

  // Opening an article reads it, unless the member marks posts read themselves (a pref).
  const articleId = article?.id ?? null
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per article opened
  useEffect(() => {
    if (!article || !prefs.markOnOpen || isRead(tables, article, Date.now())) return
    store.mutate({ type: 'markRead', articleId: article.id })
  }, [articleId])

  // A new article opens at its top (the Reader moves focus into it once its body is there).
  useEffect(() => {
    if (params.articleId !== null) window.scrollTo({ top: 0 })
  }, [params.articleId])

  const onMode = useCallback(
    (next: ReadingMode) => {
      store.mutate({ type: 'setPref', key: PREF_KEYS.mode, value: next })
      // The URL still says it, so a copied link opens the way it was being read.
      const url = new URLSearchParams(location.search)
      if (next === 'side') url.delete('mode')
      else url.set('mode', next)
      const q = url.toString()
      navigate(`/reading${q ? `?${q}` : ''}`, { replace: true })
    },
    [store, location.search, navigate],
  )

  // Closes whatever the URL has open when it runs, not what the render that bound it showed: a j
  // can have moved the URL on before React rendered it. The list it returns to is told which
  // article it closed, in that entry's own state (see the focus effect below).
  const close = useCallback(() => {
    const now = window.location.search
    const closedFrom = parseReadingParams(new URLSearchParams(now)).articleId
    const target = canonicalReadingHref(now, { articleId: null, mode: null })
    if (target !== canonicalReadingHref(now)) navigate(target, { state: { closedFrom } })
  }, [navigate])

  // The keyboard layer (ADR 0026): j and k step through the list as it is shown, Esc closes the
  // article, [ shows or hides the sidebar, f the list too while one is open, ? lists the keys. Typing in a field is never a shortcut, and a popover that handles
  // Esc itself marks the event so the article stays open.
  const [help, setHelp] = useState(false)
  // Read when a key is pressed, not when the listener was bound: a second `j` can come before
  // React has rendered the first one's navigation, and the URL is already right by then.
  const keys = useRef({ items, close, help })
  keys.current = { items, close, help }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return
      const target = e.target as HTMLElement | null
      if (target?.closest('input, textarea, select, [contenteditable]')) return
      const { items, close, help } = keys.current
      const now = parseReadingParams(new URLSearchParams(window.location.search))
      if (e.key === 'j' || e.key === 'k') {
        const at = items.findIndex((a) => a.id === now.articleId)
        const step = e.key === 'j' ? 1 : -1
        const next = items[at === -1 ? (step === 1 ? 0 : items.length - 1) : at + step]
        if (!next) return
        e.preventDefault()
        // The row's own href: no mode, so the remembered one applies (as a click does).
        navigate(readingHref({ filter: now.filter, feedId: now.feedId, articleId: next.id }))
      } else if (e.key === 'Escape') {
        if (help) setHelp(false)
        else if (now.articleId !== null) close()
        else return
        e.preventDefault()
      } else if (e.key === '[') {
        e.preventDefault()
        toggleSidebarKeepingFocus()
      } else if (e.key === 'f' && now.articleId !== null) {
        e.preventDefault()
        toggleFocus()
      } else if (e.key === '?') {
        e.preventDefault()
        setHelp((shown) => !shown)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [navigate])

  // The row of the open article stays in view as j and k move; closing puts focus back on it, so
  // the keyboard carries on from where the reader was. Leaving focus with an article open brings
  // the list back with that row in view, since j and k moved on while it was out of the grid.
  const lastOpen = useRef<number | null>(null)
  const navigationType = useNavigationType()
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per article opened or closed, or per focus change; a filter change or a later entry's state is neither
  useEffect(() => {
    const row = (id: number) =>
      document.querySelector<HTMLElement>(`[data-testid="article-row"][data-article-id="${id}"]`)
    if (params.articleId !== null) {
      lastOpen.current = params.articleId
      row(params.articleId)?.scrollIntoView({ block: 'nearest' })
      return
    }
    // A close says what it closed, in the list entry it pushed: renders can batch a j and an Esc
    // into one, or commit the j first, so the last article rendered may not be the one closed.
    // Back to that entry is not that close: the article left is the last one shown. Nor is a
    // reload of it, which has shown none yet and so focuses nothing.
    const closedFrom =
      navigationType !== 'POP'
        ? (location.state as { closedFrom?: number | null } | null)?.closedFrom
        : null
    const previous = closedFrom ?? lastOpen.current
    if (previous !== null) row(previous)?.focus()
  }, [params.articleId, focused])

  // A feed that has never been fetched: pull quickly until its first posts arrive.
  useEffect(() => {
    if (!pendingFetch) return
    const id = setInterval(() => void engine.pull(), FIRST_FETCH_PULL_MS)
    return () => clearInterval(id)
  }, [pendingFetch, engine])

  // Prefetch unread bodies and finished translations while idle: the list on screen first.
  const lastPrefetch = useRef<AbortController | null>(null)
  useEffect(() => {
    const timer = setTimeout(() => {
      lastPrefetch.current?.abort()
      const controller = new AbortController()
      lastPrefetch.current = controller
      const at = Date.now()
      const unread = (list: typeof items) =>
        list
          .filter((a) => a.contentKey && !isRead(tables, a, at))
          .map((a) => a.contentKey as string)
      const everything = articlesFor(tables, { filter: 'all', feedId: null }, at)
      void objects
        .prefetch([...unread(items), ...unread(everything)], controller.signal)
        .then(async () => {
          // Only translations the member will see on opening: none while they translate only when
          // asked, and none in a language they read as written.
          if (!prefs.autoTranslate) return
          for (const a of everything) {
            if (controller.signal.aborted || !a.contentKey) continue
            if (a.sourceLang !== null && prefs.never.includes(a.sourceLang)) continue
            const row = tables.translations.get(translationKey(a.contentKey, readingLang))
            if (row?.objectKey && (row.state === 'done' || row.state === 'partial')) {
              await objects.object(row.objectKey, controller.signal, true).catch(() => null)
            }
          }
        })
    }, PREFETCH_IDLE_MS)
    return () => clearTimeout(timer)
  }, [tables, items, objects, readingLang, prefs])

  return (
    <div
      className={`group grid flex-1 grid-cols-1 lg:min-h-0 ${gridColumns(open, panes)}`}
      data-testid="reading-layout"
      data-open={open ? '1' : undefined}
      data-sidebar={panes.sidebar}
      data-focus={focused ? '1' : undefined}
    >
      {open ? null : <MobileNav subscriptions={subs} totals={counts} params={params} />}
      {/* The sidebar, or the rail it collapses to (ADR 0030), and neither in focus. Not rendered
          rather than hidden: a `lg:hidden` against the aside's own `lg:flex` has no defined
          winner (AGENTS.md), and a column that is gone needs no element. The list is the
          exception: in focus it stays mounted and styles.css takes it out of the grid, so its
          page of rows and its scroll survive and Esc still finds the row it closed. */}
      {focused ? null : panes.sidebar === 'shown' ? (
        <Sidebar subscriptions={subs} totals={counts} params={params} />
      ) : (
        <SidebarRail subscriptions={subs} params={params} />
      )}
      <ArticleList
        items={items}
        params={params}
        title={listTitle}
        readingLang={readingLang}
        locale={locale}
        now={now}
        pendingFetch={pendingFetch}
        hidingRead={prefs.hideRead && all.length > 0}
      />
      {help ? <Shortcuts onClose={() => setHelp(false)} /> : null}
      {article ? (
        <Reader
          key={article.id}
          article={article}
          readingLang={readingLang}
          mode={mode}
          onMode={onMode}
          onClose={close}
          next={next}
        />
      ) : open && tables.profile === null ? (
        // The first sync has not landed yet (the profile always comes in the first snapshot):
        // the article is on its way, not gone.
        <ReaderPaneSkeleton />
      ) : open ? (
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
        <EmptyState unread={counts.all} hasSubscriptions={subs.length > 0} />
      )}
    </div>
  )
}

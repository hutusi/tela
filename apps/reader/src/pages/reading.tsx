/**
 * `/reading`: sidebar, list, and the open article. The URL is the one owner of what is open
 * (ADR 0017's rule, kept), and every pane is a function of it and the local store, so a click, a
 * filter change or Back is a render, not a request (ADR 0025).
 */
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
import { PREF_KEYS, readingPrefsOf, useReadingPrefs } from '../lib/prefs'
import { useNow, useReadingLang, useStore, useTables } from '../store/hooks'
import {
  articlesFor,
  isLiked,
  isRead,
  prefetchPlan,
  shownRead,
  shownTitle,
  subscriptionItems,
  totals,
  withoutRead,
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
  // Hiding read posts (a pref) must not pull a post out from under the reader: a post seen unread
  // in this list stays in it until the reader moves to another list, so opening a post, or j and
  // k, never lose their place. That includes posts the catch-up pull brings after the list was
  // first painted from the device, which are the first a member opens.
  const listKey = `${params.filter}:${params.feedId}`
  const seenUnread = useRef<{ key: string; ids: Set<number> }>({ key: '', ids: new Set() })
  if (seenUnread.current.key !== listKey) seenUnread.current = { key: listKey, ids: new Set() }
  const seen = seenUnread.current.ids
  const items = useMemo(
    () => (prefs.hideRead ? withoutRead(tables, all, now, params.articleId, seen) : all),
    [all, prefs.hideRead, seen, tables, now, params.articleId],
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

  // Opening an article reads it, unless the member marks posts read themselves (a pref). Once per
  // open, so a post the member marks unread while it is open stays unread until the next open; one
  // marked unread before is read by opening it, like any unread post.
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
  // article, [ shows or hides the sidebar, f the list too while one is open, o opens its original,
  // l likes or unlikes it and m marks it read or unread, ? lists the keys. Typing in a field is
  // never a shortcut, and a popover that handles Esc itself marks the event so the article stays
  // open.
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
      } else if ((e.key === 'o' || e.key === 'l' || e.key === 'm') && now.articleId !== null) {
        // A key held down repeats: one tab and one turn of the like or the read per press, not
        // per repeat.
        if (e.repeat) return
        // The article the URL has open and its state as the store has them now: a j a moment ago
        // may not have rendered yet, and a like or a read from another tab may have synced since.
        const { tables } = store.getSnapshot()
        const article = store.article(tables, now.articleId)
        if (!article) return
        if (e.key === 'o') {
          // Ingest keeps only http(s) links; a script opening one checks again all the same.
          if (!article.url || !/^https?:\/\//i.test(article.url)) return
          e.preventDefault()
          // As the meta line's link opens it: a new tab that cannot reach back into this one.
          window.open(article.url, '_blank', 'noopener,noreferrer')
        } else if (e.key === 'l') {
          e.preventDefault()
          store.mutate({
            type: 'setLiked',
            articleId: article.id,
            liked: !isLiked(tables, article.id),
          })
        } else {
          e.preventDefault()
          // The other way from what the reader's button and the list's dot show, which ask the
          // same question: the open post counts as read while opening reads it.
          const { markOnOpen } = readingPrefsOf(tables)
          const read = shownRead(tables, article, Date.now(), true, markOnOpen)
          store.mutate({ type: read ? 'markUnread' : 'markRead', articleId: article.id })
        }
      } else if (e.key === '?') {
        e.preventDefault()
        setHelp((shown) => !shown)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [navigate, store])

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

  // Prefetch unread bodies and finished translations while idle: the list on screen first. Keyed on
  // what it would fetch, not on the tables: every pull makes new ones, even an empty pull a minute,
  // and a timer reset by each would put the prefetch off, and cancel one under way, for nothing.
  // An open marks a post read, which changes the plan, so each open plans again.
  const plan = useMemo(
    () => JSON.stringify(prefetchPlan(tables, items, now, readingLang, prefs)),
    [tables, items, now, readingLang, prefs],
  )
  // On each pull, ask again when the device lacks part of the plan and no run is under way: a run
  // fell short (the network went, a request failed), or bodies went since (eviction drops bodies
  // not opened for a week, unread ones too, ten seconds after boot). The engine pulls when the
  // browser is back online, on focus and every minute, and the plan is the same by then, so
  // nothing else would ask. A pull while the device holds all of it changes nothing.
  const [retry, setRetry] = useState(0)
  /** A translation the last run could not fetch: the device keeps no list of those to check. */
  const fellShort = useRef(false)
  const running = useRef<{ plan: string; controller: AbortController; done: boolean } | null>(null)
  // biome-ignore lint/correctness/useExhaustiveDependencies: on every pull, by its new tables
  useEffect(() => {
    const last = running.current
    if (last && !last.done) return
    let cancelled = false
    const { bodies } = JSON.parse(plan) as ReturnType<typeof prefetchPlan>
    void objects.missing(bodies).then((missing) => {
      if (cancelled || (missing.length === 0 && !fellShort.current)) return
      fellShort.current = false
      setRetry((n) => n + 1)
    })
    return () => {
      cancelled = true
    }
  }, [tables, plan, objects])
  // biome-ignore lint/correctness/useExhaustiveDependencies: `retry` asks again for the same plan
  useEffect(() => {
    const timer = setTimeout(() => {
      const last = running.current
      // Still fetching this very plan: let it finish rather than start it over.
      if (last && !last.done && last.plan === plan) return
      last?.controller.abort()
      const controller = new AbortController()
      const mine = { plan, controller, done: false }
      running.current = mine
      const { bodies, translations } = JSON.parse(plan) as ReturnType<typeof prefetchPlan>
      const run = async () => {
        await objects.prefetch(bodies, controller.signal)
        for (const key of translations) {
          if (controller.signal.aborted) return
          const object = await objects.object(key, controller.signal, true).catch(() => null)
          // A run cancelled for a newer plan did not fall short: the newer one is on its way.
          if (object === null && !controller.signal.aborted) fellShort.current = true
        }
      }
      void run()
        .catch(() => undefined)
        .finally(() => {
          mine.done = true
        })
    }, PREFETCH_IDLE_MS)
    return () => clearTimeout(timer)
  }, [plan, objects, retry])

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

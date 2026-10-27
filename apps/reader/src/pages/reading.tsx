/**
 * `/reading`: sidebar, list, and the open article. The URL is the one owner of what is open
 * (ADR 0017's rule, kept), and every pane is a function of it and the local store, so a click, a
 * filter change or Back is a render, not a request (ADR 0025).
 */
import type { FeedStatus } from '@tela/shared'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate, useNavigationType, useSearchParams } from 'react-router'
import { useTranslations } from 'use-intl'
import { ArticleList, type ListShow, listRow } from '../components/article-list'
import { EmptyState } from '../components/empty-state'
import { ErrorBoundary, RouteFailed } from '../components/error-boundary'
import { FirstRun, showsFirstRun } from '../components/first-run'
import { MobileNav } from '../components/mobile-nav'
import { Reader } from '../components/reader'
import { Shortcuts } from '../components/shortcuts'
import { Sidebar } from '../components/sidebar'
import { SidebarRail } from '../components/sidebar-rail'
import { toggleSidebarKeepingFocus } from '../components/sidebar-toggle'
import { ListPanesSkeleton, ReaderPaneSkeleton } from '../components/skeletons'
import {
  canonicalReadingHref,
  listsFilter,
  parseReadingParams,
  type ReadingMode,
  readingHref,
} from '../lib/href'
import { effectiveSidebar, gridColumns, toggleFocus, useLayout, useWide } from '../lib/layout'
import { openMarker } from '../lib/open-post'
import { PREF_KEYS, readingPrefsOf, useReadingPrefs } from '../lib/prefs'
import { useTitle } from '../lib/title'
import { useQuickPull } from '../lib/use-quick-pull'
import { useNow, useReadingLang, useStore, useTables } from '../store/hooks'
import { PostRefused } from '../store/objects'
import {
  articlesFor,
  feedTitle,
  folderTree,
  isLiked,
  isSubscribed,
  type PrefetchPlan,
  prefetchCovers,
  prefetchPlan,
  shownRead,
  shownTitle,
  subscriptionItems,
  subscriptionsSignature,
  totals,
  withoutRead,
} from '../store/selectors'
import { useUi } from '../ui'

const PREFETCH_IDLE_MS = 1500
/** The feed status tela-jobs fetches (`FEED_STATUSES`): a paused or dead feed brings no posts. */
const FEED_ACTIVE: FeedStatus = 'active'

export function ReadingPage() {
  const t = useTranslations('reader')
  const ts = useTranslations('sidebar')
  const tables = useTables()
  const now = useNow()
  const { locale } = useUi()
  const readingLang = useReadingLang(locale)
  const { store, objects, engine } = useStore()
  const [search] = useSearchParams()
  const location = useLocation()
  const navigate = useNavigate()
  const params = parseReadingParams(search)
  // Whether the device holds the member's rows: the profile always comes in the first snapshot.
  // Before it lands (a new device) the panes are placeholders, never an empty list.
  const synced = tables.profile !== null

  const subs = subscriptionItems(tables, now)
  // The sidebar's order (ADR 0048): the member's folders by name, then the blogs in none.
  const tree = folderTree(tables, now)
  const counts = totals(tables, now)
  const prefs = useReadingPrefs(tables)
  const all = articlesFor(tables, params, now)
  // Unread or All, the switch under the list's heading (a pref, so every device reads the same
  // way). Liked has none and shows everything: it is a shelf, and liking a post reads it.
  const liked = listsFilter(params, 'liked')
  const unreadOnly = prefs.hideRead && !liked
  // Showing only unread posts must not pull a post out from under the reader: a post seen unread
  // in this list stays in it until the reader moves to another list or turns the switch, so
  // opening a post, or j and k, never lose their place. That includes posts the catch-up pull
  // brings after the list was first painted from the device, which are the first a member opens.
  // Mark all read lets them all go (`letSeenGo`), so the list says it is caught up: a new key,
  // since the press may change nothing else to render (the posts kept were read already).
  const [letGo, setLetGo] = useState(0)
  const list = `${params.filter}:${params.feedId}:${params.folderId}`
  const listKey = `${list}:${unreadOnly ? 'unread' : 'all'}:${letGo}`
  const seenUnread = useRef<{ key: string; ids: Set<number> }>({ key: '', ids: new Set() })
  if (seenUnread.current.key !== listKey) seenUnread.current = { key: listKey, ids: new Set() }
  const seen = seenUnread.current.ids
  const items = useMemo(
    () => (unreadOnly ? withoutRead(tables, all, now, params.articleId, seen) : all),
    [all, unreadOnly, seen, tables, now, params.articleId],
  )
  const onShow = useCallback(
    (show: ListShow) =>
      store.mutate({ type: 'setPref', key: PREF_KEYS.hideRead, value: show === 'unread' }),
    [store],
  )
  const letSeenGo = useCallback(() => setLetGo((n) => n + 1), [])
  const selected = params.feedId !== null ? subs.find((s) => s.feedId === params.feedId) : undefined
  const folder =
    params.folderId !== null ? tree.folders.find((f) => f.id === params.folderId) : undefined
  // A folder the device does not hold once it holds the member's rows (the profile comes in the
  // first snapshot, with the folders): deleted, here or on another device, or never one of theirs.
  const folderGone = params.folderId !== null && folder === undefined && tables.profile !== null
  const listTitle =
    params.feedId !== null
      ? (selected?.title ?? '')
      : params.folderId !== null
        ? (folder?.name ?? '')
        : undefined
  // What a phone's back bar goes back to, by the name the list's own disclosure gives it.
  const listName =
    params.feedId !== null
      ? (selected?.title ?? ts('subscriptions'))
      : params.folderId !== null
        ? (folder?.name ?? ts('subscriptions'))
        : ts(params.filter)
  const pendingFetch = selected !== undefined && selected.lastFetchedAt === null
  // Quickly, while it waits for its first fetch: only a feed tela-jobs fetches (not paused, not
  // given up on), so its posts appear when they land.
  const awaitingFirst =
    pendingFetch && tables.feeds.get(selected.feedId)?.status === FEED_ACTIVE
      ? `feed:${selected.feedId}`
      : null
  useQuickPull(awaitingFirst, () => void engine.pull())
  const article =
    params.articleId !== null ? (store.article(tables, params.articleId) ?? null) : null
  const open = params.articleId !== null
  // The tab says what is open: the post, by the title the reader shows first (its translation,
  // when there is one), or the list. A post still on its way names nothing yet.
  useTitle(
    article ? shownTitle(tables, article, readingLang, prefs.never).title : open ? null : listName,
  )
  // Which panes show beside the article: this device's choice, not the member's (ADR 0029), and
  // until it has chosen, the window's: an article opened below 1200px starts with the rail. In
  // focus an open article has the page to itself; a closed one shows the list as ever.
  const stored = useLayout()
  const wide = useWide()
  const panes = { sidebar: effectiveSidebar(stored.sidebar, open, wide), focus: stored.focus }
  const focused = open && panes.focus === 'on'

  // The first run (Tela v5), for a member who follows nothing: never before the first pull, which
  // brings the profile with the subscriptions, so it cannot flash for one who follows some. Once
  // shown it is latched for that account, so subscribing from it keeps it up until the member
  // starts reading; an open article has the page meanwhile, and Liked keeps its list, since a
  // member who follows nothing may still have kept posts (`showsFirstRun`). The latch is this
  // page's, not the account's, on purpose: it only keeps the page still under its own Subscribe
  // buttons, so a member who leaves for Discover or /add and subscribes there comes back to their
  // list, not to a page asking them to start.
  const empty = tables.profile !== null && subs.length === 0 && !open
  const [firstRunFor, setFirstRunFor] = useState<string | null>(null)
  if (empty && store.userId !== null && firstRunFor !== store.userId) setFirstRunFor(store.userId)
  const firstRun = showsFirstRun({
    synced: tables.profile !== null,
    subscriptions: subs.length,
    open,
    filter: params.filter,
    latched: firstRunFor !== null && firstRunFor === store.userId,
  })
  const startReading = () => {
    setFirstRunFor(null)
    // On the list of everything followed, whichever the sidebar was pointed at meanwhile.
    if (canonicalReadingHref(window.location.search) !== readingHref({})) navigate(readingHref({}))
  }

  // The post after this one in the list as shown, the one `j` would open: a card at the end of
  // the article offers it, so a pointer reader flows on without going back up to the list.
  const at = article ? items.findIndex((a) => a.id === article.id) : -1
  const after = at === -1 ? undefined : items[at + 1]
  const nextTitle = after ? shownTitle(tables, after, readingLang, prefs.never) : null
  const next = after
    ? {
        href: readingHref({ ...params, articleId: after.id, mode: null }),
        title: nextTitle?.title ?? after.title,
        lang: nextTitle?.lang,
        blog: feedTitle(tables, after.feedId) || store.sourceName(after.feedId),
      }
    : null

  // The mode a URL without one means: this member's last choice, synced like any other pref.
  const mode = params.mode ?? prefs.mode

  // Opening an article reads it, unless the member marks posts read themselves (a pref). Once per
  // open, so a post the member marks unread while it is open stays unread until the next open; one
  // marked unread before is read by opening it, like any unread post. A post from a blog the member
  // does not subscribe to is read once its body is there (the Reader's `onReadable`): one refused
  // for the day's limit (ADR 0066) has nothing read, and stays unread.
  const articleId = article?.id ?? null
  const marker = useMemo(() => openMarker(store), [store])
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per article opened
  useEffect(() => {
    if (article) marker.opened(article)
    // Run before the next article's effects, the Reader's among them, in the same commit.
    return () => marker.left()
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
  // l likes or unlikes it and m marks it read or unread, ? lists the keys (u, the toast's Undo, is
  // the toast's own, on every page). Typing in a field is never a shortcut, nor is a key pressed in
  // a modal dialog (the phone's Recommend sheet), which the page under it does not own; and a
  // popover that handles Esc itself marks the event so the article stays open.
  // The list of keys is a modal dialog, which takes Esc and the keys while it is open, and gives
  // focus back to what had it as `?` was pressed.
  const [help, setHelp] = useState(false)
  const helpOpener = useRef<HTMLElement | null>(null)
  // Read when a key is pressed, not when the listener was bound: a second `j` can come before
  // React has rendered the first one's navigation, and the URL is already right by then.
  const keys = useRef({ items, close })
  keys.current = { items, close }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return
      const target = e.target as HTMLElement | null
      if (target?.closest('input, textarea, select, [contenteditable]')) return
      if (document.querySelector('dialog:modal')) return
      const { items, close } = keys.current
      const now = parseReadingParams(new URLSearchParams(window.location.search))
      if (e.key === 'j' || e.key === 'k') {
        const at = items.findIndex((a) => a.id === now.articleId)
        const step = e.key === 'j' ? 1 : -1
        const next = items[at === -1 ? (step === 1 ? 0 : items.length - 1) : at + step]
        if (!next) return
        e.preventDefault()
        // The row's own href, in the list the URL names now: no mode, so the remembered one
        // applies (as a click does).
        navigate(canonicalReadingHref(window.location.search, { articleId: next.id, mode: null }))
      } else if (e.key === 'Escape') {
        if (now.articleId === null) return
        close()
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
        helpOpener.current =
          document.activeElement instanceof HTMLElement ? document.activeElement : null
        setHelp(true)
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
    if (params.articleId !== null) {
      lastOpen.current = params.articleId
      listRow(params.articleId)?.scrollIntoView({ block: 'nearest' })
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
    if (previous !== null) listRow(previous)?.focus()
  }, [params.articleId, focused])

  // The post after the open one, which `j` and the card at the article's end open: fetched as this
  // one opens, not when the idle prefetch reaches it (an open restarts that timer), so stepping
  // through a list never waits on the network. Read or not: the list may show read posts.
  // Only from a blog the member subscribes to, as the idle prefetch (`prefetchPlan`): any other's
  // would count against the day's limit on them (ADR 0066) before anyone opened it.
  const upNext =
    article && after && isSubscribed(tables, after.feedId) ? (after.contentKey ?? null) : null
  useEffect(() => {
    if (upNext) void objects.body(upNext).catch(() => undefined)
  }, [upNext, objects])
  // A change to the subscriptions may free posts refused for the day: asked for again.
  const subscriptionRows = tables.subscriptions
  const subscriptions = useMemo(
    () => subscriptionsSignature({ subscriptions: subscriptionRows }),
    [subscriptionRows],
  )
  useEffect(() => objects.noteSubscriptions(subscriptions), [subscriptions, objects])

  // Prefetch unread bodies and finished translations while idle: the list on screen first. Keyed on
  // what it would fetch, not on the tables: every pull that brings anything makes new ones, and a
  // timer reset by each would put the prefetch off, and cancel one under way, for nothing. An open
  // marks a post read, which changes the plan, so each open plans again; a run under way that
  // already covers the new plan goes on (`prefetchCovers`).
  const plan = useMemo(
    () => JSON.stringify(prefetchPlan(tables, items, now, readingLang, prefs)),
    [tables, items, now, readingLang, prefs],
  )
  // After each pull, and each change to the tables, ask again when the device lacks part of the
  // plan and no run is under way: a run fell short (the network went, a request failed), or
  // bodies went since (eviction drops bodies not opened for a week, unread ones too, ten seconds
  // after boot). The plan is the same by then, so nothing else would ask. A pull that brings
  // nothing leaves the tables as they were (`LocalStore.applyPull`), so the engine says it pulled
  // (`onPulled`): that pull is the network coming back. Asking while the device holds all of the
  // plan changes nothing.
  const [retry, setRetry] = useState(0)
  /** A translation the last run could not fetch: the device keeps no list of those to check. */
  const fellShort = useRef(false)
  const running = useRef<{
    plan: string
    fetching: PrefetchPlan
    controller: AbortController
    done: boolean
  } | null>(null)
  /** The look itself, current with this render's plan, for the effect and the engine alike. */
  const lookAgain = useRef((_cancelled: () => boolean) => {})
  lookAgain.current = (cancelled) => {
    const last = running.current
    if (last && !last.done) return
    const { bodies } = JSON.parse(plan) as ReturnType<typeof prefetchPlan>
    void objects.missing(bodies).then((missing) => {
      if (cancelled() || (missing.length === 0 && !fellShort.current)) return
      fellShort.current = false
      setRetry((n) => n + 1)
    })
  }
  // biome-ignore lint/correctness/useExhaustiveDependencies: on every change to the tables or the plan
  useEffect(() => {
    let cancelled = false
    lookAgain.current(() => cancelled)
    return () => {
      cancelled = true
    }
  }, [tables, plan, objects])
  useEffect(() => engine.onPulled(() => lookAgain.current(() => false)), [engine])
  // biome-ignore lint/correctness/useExhaustiveDependencies: `retry` asks again for the same plan
  useEffect(() => {
    const timer = setTimeout(() => {
      const last = running.current
      const next = JSON.parse(plan) as PrefetchPlan
      // Still fetching this plan, or one that holds all of it: let it finish rather than start
      // over. Its own plan stays the one to compare with, since that is what it is fetching.
      if (last && !last.done && (last.plan === plan || prefetchCovers(last.fetching, next))) return
      last?.controller.abort()
      const controller = new AbortController()
      const mine = { plan, fetching: next, controller, done: false }
      running.current = mine
      const { bodies, translations } = next
      const run = async () => {
        await objects.prefetch(bodies, controller.signal)
        for (const key of translations) {
          if (controller.signal.aborted) return
          // A post refused for the day (ADR 0066) did not fall short either: asking again before
          // the day turns is refused again, so it is not worth a run.
          const object = await objects
            .object(key, controller.signal, true)
            .catch((err: unknown) => (err instanceof PostRefused ? undefined : null))
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
      className={`group grid flex-1 grid-cols-1 lg:min-h-0 ${gridColumns(open, panes, !firstRun)}`}
      data-testid="reading-layout"
      data-open={open ? '1' : undefined}
      data-sidebar={panes.sidebar}
      data-focus={focused ? '1' : undefined}
    >
      {synced ? (
        <>
          {/* Over the first run too: on a phone it is the only way to Liked, and a member who
              follows nothing may still have kept posts there, as the sidebar beside it does on a
              desktop. */}
          {open ? null : <MobileNav tree={tree} totals={counts} params={params} />}
          {/* The sidebar, or the rail it collapses to (ADR 0030), and neither in focus. Not
              rendered rather than hidden: a `lg:hidden` against the aside's own `lg:flex` has no
              defined winner (AGENTS.md), and a column that is gone needs no element. The list is
              the exception: in focus it stays mounted and styles.css takes it out of the grid, so
              its page of rows and its scroll survive and Esc still finds the row it closed. */}
          {focused ? null : panes.sidebar === 'shown' ? (
            <Sidebar tree={tree} totals={counts} params={params} />
          ) : (
            <SidebarRail tree={tree} params={params} />
          )}
          {firstRun ? null : (
            <ArticleList
              items={items}
              params={params}
              title={listTitle}
              readingLang={readingLang}
              locale={locale}
              now={now}
              pendingFetch={pendingFetch}
              show={liked || folderGone ? null : unreadOnly ? 'unread' : 'all'}
              onShow={onShow}
              caughtUp={unreadOnly && all.length > 0}
              onMarkAll={letSeenGo}
              folder={folderGone ? 'gone' : folder}
            />
          )}
        </>
      ) : focused ? null : panes.sidebar === 'shown' ? (
        // A device whose first sync has not landed holds no rows yet: placeholders, never a list
        // that says there is nothing here.
        <ListPanesSkeleton />
      ) : (
        <>
          <SidebarRail tree={tree} params={params} />
          <ListPanesSkeleton sidebar={false} />
        </>
      )}
      {help ? <Shortcuts opener={helpOpener} onClose={() => setHelp(false)} /> : null}
      {firstRun ? (
        // In place of the list and the empty pane, at every width.
        <FirstRun
          readingLang={readingLang}
          locale={locale}
          subscribed={subs.length}
          onStart={startReading}
        />
      ) : article ? (
        // One article that throws as it renders fails in its own pane: the list beside it, j and
        // k, Esc, Back and the header all still work, and the next article is a new boundary.
        <ErrorBoundary key={article.id} fallback={(retry) => <RouteFailed onRetry={retry} />}>
          <Reader
            article={article}
            readingLang={readingLang}
            mode={mode}
            onMode={onMode}
            onClose={close}
            next={next}
            listName={listName}
            onReadable={marker.readable}
          />
        </ErrorBoundary>
      ) : open && !synced ? (
        // The first sync has not landed yet: the article is on its way, not gone.
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
      ) : synced ? (
        <EmptyState unread={counts.all} hasSubscriptions={subs.length > 0} />
      ) : null}
    </div>
  )
}

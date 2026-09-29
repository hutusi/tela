/**
 * `/reading`: sidebar, list, and the open article. The URL is the one owner of what is open
 * (ADR 0017's rule, kept), and every pane is a function of it and the local store, so a click, a
 * filter change or Back is a render, not a request (ADR 0025).
 */
import { translationKey } from '@tela/sync'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate, useNavigationType, useSearchParams } from 'react-router'
import { useTranslations } from 'use-intl'
import { ArticleList } from '../components/article-list'
import { EmptyState } from '../components/empty-state'
import { MobileNav } from '../components/mobile-nav'
import { Reader } from '../components/reader'
import { Shortcuts } from '../components/shortcuts'
import { Sidebar } from '../components/sidebar'
import { ReaderPaneSkeleton } from '../components/skeletons'
import {
  canonicalReadingHref,
  parseReadingParams,
  type ReadingMode,
  readingHref,
  readingModeParam,
} from '../lib/href'
import { useNow, useReadingLang, useStore, useTables } from '../store/hooks'
import { articlesFor, isRead, subscriptionItems, totals } from '../store/selectors'
import { useUi } from '../ui'

const MODE_PREF = 'reader.mode'
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
  const items = articlesFor(tables, params, now)
  const selected = params.feedId !== null ? subs.find((s) => s.feedId === params.feedId) : undefined
  const listTitle = params.feedId !== null ? (selected?.title ?? '') : undefined
  const pendingFetch = selected !== undefined && selected.lastFetchedAt === null
  const article =
    params.articleId !== null ? (store.article(tables, params.articleId) ?? null) : null
  const open = params.articleId !== null

  // The mode a URL without one means: this member's last choice, synced like any other pref.
  const remembered =
    readingModeParam((tables.prefs.get(MODE_PREF)?.value as string | undefined) ?? null) ?? 'side'
  const mode = params.mode ?? remembered

  // Opening an article reads it.
  const articleId = article?.id ?? null
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per article opened
  useEffect(() => {
    if (!article || isRead(tables, article, Date.now())) return
    store.mutate({ type: 'markRead', articleId: article.id })
  }, [articleId])

  // A new article opens at its top (the Reader moves focus into it once its body is there).
  useEffect(() => {
    if (params.articleId !== null) window.scrollTo({ top: 0 })
  }, [params.articleId])

  const onMode = useCallback(
    (next: ReadingMode) => {
      store.mutate({ type: 'setPref', key: MODE_PREF, value: next })
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
  // article, ? lists the keys. Typing in a field is never a shortcut, and a popover that handles
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
      } else if (e.key === '?') {
        e.preventDefault()
        setHelp((shown) => !shown)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [navigate])

  // The row of the open article stays in view as j and k move; closing puts focus back on it, so
  // the keyboard carries on from where the reader was.
  const lastOpen = useRef<number | null>(null)
  const navigationType = useNavigationType()
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per article opened or closed; a filter change or a later entry's state is neither
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
    // Back to that entry, or a reload of it, is not that close: the article left is the last one
    // shown.
    const closedFrom =
      navigationType !== 'POP'
        ? (location.state as { closedFrom?: number | null } | null)?.closedFrom
        : null
    const previous = closedFrom ?? lastOpen.current
    if (previous !== null) row(previous)?.focus()
  }, [params.articleId])

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
          for (const a of everything) {
            if (controller.signal.aborted || !a.contentKey) continue
            const row = tables.translations.get(translationKey(a.contentKey, readingLang))
            if (row?.objectKey && (row.state === 'done' || row.state === 'partial')) {
              await objects.object(row.objectKey, controller.signal).catch(() => null)
            }
          }
        })
    }, PREFETCH_IDLE_MS)
    return () => clearTimeout(timer)
  }, [tables, items, objects, readingLang])

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
      {open ? null : <MobileNav subscriptions={subs} totals={counts} params={params} />}
      <Sidebar subscriptions={subs} totals={counts} params={params} />
      <ArticleList
        items={items}
        params={params}
        title={listTitle}
        readingLang={readingLang}
        locale={locale}
        now={now}
        pendingFetch={pendingFetch}
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

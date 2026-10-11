/**
 * Which panes the reading page shows beside the article (ADR 0029): the sidebar can be hidden,
 * which shows its rail in its place (ADR 0030), and in focus the list goes too while an article
 * is open.
 *
 * This is state of the device, not a synced pref: a 13" laptop hides what a 27" monitor has room
 * for, so the choice belongs to the screen it was made on. It lives in localStorage behind this
 * one store, in the shape of the synced prefs — names rather than booleans, so a value a later
 * build writes falls back to the default here — and a store that cannot be read or written
 * (private mode, a blocked origin) leaves the defaults and the choice holds for the session.
 *
 * Until the device has chosen, the sidebar follows the window (Tela v5): an article opened below
 * 1200px starts with the rail, which is what gives it room, and the sidebar is back once it
 * closes or the window widens. A choice made with the toggle or `[` holds at every width.
 */
import { useSyncExternalStore } from 'react'
import { parseReadingParams } from './href'
import { pick } from './typography'

export const SIDEBAR = ['shown', 'hidden'] as const
export const FOCUS = ['off', 'on'] as const
export type Sidebar = (typeof SIDEBAR)[number]
export type Focus = (typeof FOCUS)[number]
/** What the page shows. */
export type Layout = { sidebar: Sidebar; focus: Focus }
/** What the device has stored: no sidebar until it has been chosen here. */
export type Stored = { sidebar: Sidebar | null; focus: Focus }

const KEYS: Record<keyof Layout, string> = { sidebar: 'tela.sidebar', focus: 'tela.focus' }
const OURS = new Set(Object.values(KEYS))
const DEFAULT: Stored = { sidebar: null, focus: 'off' }

/** From here the window has room for the sidebar beside an open article: 1200px. */
export const WIDE = '(min-width: 75rem)'

let cached: Stored | null = null
const listeners = new Set<() => void>()
let watching = false

/**
 * Another tab's change arrives as its `storage` event (a tab never gets its own), which drops the
 * cache so the next read comes from the store. One listener for the module's life, not one per
 * subscriber: a tab away from the reading page has no subscriber, and a cache kept through that
 * gap would hand it the layout it left with when it comes back.
 */
function watch(): void {
  if (watching) return
  watching = true
  window.addEventListener('storage', (e) => {
    // `key === null` is `clear()`.
    if (e.key !== null && !OURS.has(e.key)) return
    cached = null
    for (const listener of listeners) listener()
  })
}

function read(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

const sidebarOf = (value: string | null): Sidebar | null =>
  SIDEBAR.includes(value as Sidebar) ? (value as Sidebar) : null

/**
 * What this device has chosen: read once, kept until something here or in another tab changes it.
 * A sidebar value this build does not know is no choice at all.
 */
export function layout(): Stored {
  watch()
  cached ??= {
    sidebar: sidebarOf(read(KEYS.sidebar)),
    focus: pick(read(KEYS.focus), FOCUS, DEFAULT.focus),
  }
  return cached
}

export function setLayout(patch: Partial<Layout>): void {
  cached = { ...layout(), ...patch }
  for (const name of Object.keys(patch) as (keyof Layout)[]) {
    try {
      localStorage.setItem(KEYS[name], patch[name] as string)
    } catch {}
  }
  for (const listener of listeners) listener()
}

/** The sidebar the page shows: the device's choice, else the rail beside an article in a narrow window. */
export function effectiveSidebar(stored: Sidebar | null, open: boolean, wide: boolean): Sidebar {
  return stored ?? (open && !wide ? 'hidden' : 'shown')
}

/** Whether the window is wide now. One with no `matchMedia` (a test, a server) is. */
function wideNow(): boolean {
  return typeof matchMedia === 'function' ? matchMedia(WIDE).matches : true
}

/**
 * Store the other sidebar from the one shown, read when it runs: the URL says whether an article
 * is open, and the window how wide it is, so from the rail an article opened in a narrow window
 * starts with, this stores `shown`.
 */
export function toggleSidebar(): void {
  const open =
    typeof location === 'undefined'
      ? false
      : parseReadingParams(new URLSearchParams(location.search)).articleId !== null
  const shown = effectiveSidebar(layout().sidebar, open, wideNow())
  setLayout({ sidebar: shown === 'hidden' ? 'shown' : 'hidden' })
}

export function toggleFocus(): void {
  setLayout({ focus: layout().focus === 'on' ? 'off' : 'on' })
}

/** Hear this tab's changes, made through `setLayout`, and another tab's, heard by `watch`. */
export function subscribeLayout(listener: () => void): () => void {
  watch()
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function useLayout(): Stored {
  return useSyncExternalStore(subscribeLayout, layout, () => DEFAULT)
}

/**
 * Whether the window is wide enough for the sidebar beside an open article, kept as it resizes:
 * with nothing stored, the sidebar follows it live. A server render, which has no window, says so.
 */
export function useWide(): boolean {
  return useSyncExternalStore(
    (changed) => {
      if (typeof matchMedia !== 'function') return () => {}
      const query = matchMedia(WIDE)
      query.addEventListener('change', changed)
      return () => query.removeEventListener('change', changed)
    },
    wideNow,
    () => true,
  )
}

/**
 * The reading grid's columns from `lg`: sidebar, list, article. The list is narrower while an
 * article is open, the sidebar's column narrows to its 48px rail when it collapses, and in focus
 * an open article has the grid to itself. Whole literals, so Tailwind's scanner sees each one.
 */
export function gridColumns(open: boolean, { sidebar, focus }: Layout): string {
  if (open && focus === 'on') return 'lg:grid-cols-[minmax(0,1fr)]'
  if (sidebar === 'hidden') {
    return open
      ? 'lg:grid-cols-[48px_260px_minmax(0,1fr)]'
      : 'lg:grid-cols-[48px_minmax(280px,380px)_minmax(0,1fr)]'
  }
  return open
    ? 'lg:grid-cols-[220px_260px_minmax(0,1fr)]'
    : 'lg:grid-cols-[220px_minmax(280px,380px)_minmax(0,1fr)]'
}

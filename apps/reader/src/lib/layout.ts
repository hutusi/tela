/**
 * Which panes the reading page shows beside the article (ADR 0029): the sidebar can be hidden.
 *
 * This is state of the device, not a synced pref: a 13" laptop hides what a 27" monitor has room
 * for, so the choice belongs to the screen it was made on. It lives in localStorage behind this
 * one store, in the shape of the synced prefs — names rather than booleans, so a value a later
 * build writes falls back to the default here — and a store that cannot be read or written
 * (private mode, a blocked origin) leaves the defaults and the choice holds for the session.
 */
import { useSyncExternalStore } from 'react'
import { pick } from './typography'

export const SIDEBAR = ['shown', 'hidden'] as const
export type Sidebar = (typeof SIDEBAR)[number]
export type Layout = { sidebar: Sidebar }

const KEYS: Record<keyof Layout, string> = { sidebar: 'tela.sidebar' }
const DEFAULT: Layout = { sidebar: 'shown' }

let cached: Layout | null = null
const listeners = new Set<() => void>()

function read(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

/** What this device has chosen: read once, kept until something here or in another tab changes it. */
export function layout(): Layout {
  cached ??= { sidebar: pick(read(KEYS.sidebar), SIDEBAR, DEFAULT.sidebar) }
  return cached
}

export function setLayout(patch: Partial<Layout>): void {
  cached = { ...layout(), ...patch }
  for (const name of Object.keys(patch) as (keyof Layout)[]) {
    try {
      localStorage.setItem(KEYS[name], cached[name])
    } catch {}
  }
  for (const listener of listeners) listener()
}

export function toggleSidebar(): void {
  setLayout({ sidebar: layout().sidebar === 'hidden' ? 'shown' : 'hidden' })
}

/**
 * Hear every change: this tab's through `setLayout`, another tab's through its `storage` event
 * (a tab never gets its own), which drops the cache so the next read comes from the store.
 */
export function subscribeLayout(listener: () => void): () => void {
  listeners.add(listener)
  const ours = new Set(Object.values(KEYS))
  const onStorage = (e: StorageEvent) => {
    // `key === null` is `clear()`.
    if (e.key !== null && !ours.has(e.key)) return
    cached = null
    listener()
  }
  window.addEventListener('storage', onStorage)
  return () => {
    listeners.delete(listener)
    window.removeEventListener('storage', onStorage)
  }
}

export function useLayout(): Layout {
  return useSyncExternalStore(subscribeLayout, layout, () => DEFAULT)
}

/**
 * The reading grid's columns from `lg`: sidebar, list, article. The list is narrower while an
 * article is open, and the sidebar's column goes with the sidebar. Whole literals, so Tailwind's
 * scanner sees each one.
 */
export function gridColumns(open: boolean, { sidebar }: Layout): string {
  if (sidebar === 'hidden') {
    return open
      ? 'lg:grid-cols-[260px_minmax(0,1fr)]'
      : 'lg:grid-cols-[minmax(280px,380px)_minmax(0,1fr)]'
  }
  return open
    ? 'lg:grid-cols-[220px_260px_minmax(0,1fr)]'
    : 'lg:grid-cols-[220px_minmax(280px,380px)_minmax(0,1fr)]'
}

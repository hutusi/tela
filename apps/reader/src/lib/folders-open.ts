/**
 * Which of the member's folders this device shows closed in the sidebar and the phone's Feeds
 * menu (ADR 0048). A folder starts open, so what is kept is the set closed.
 *
 * Device state, as the panes are (ADR 0029, `layout.ts`): a phone with room for three blogs
 * closes what a monitor keeps open, so the choice belongs to the screen it was made on, not the
 * account. It lives in localStorage behind this one store, read once and cached; a store that
 * cannot be read or written (private mode, a blocked origin) leaves every folder open, and a
 * choice made then holds for the session. Other tabs follow through the `storage` event.
 */
import { useSyncExternalStore } from 'react'

const KEY = 'tela.folders.closed'

/**
 * The most ids kept, newest last. Folders are deleted and made over the years, on every account
 * this browser has held, and nothing here knows which ids are still folders: a bound keeps the
 * value small, and an id dropped from it only opens a folder closed long ago.
 */
export const CLOSED_MAX = 200

const NONE: ReadonlySet<string> = new Set()

let cached: ReadonlySet<string> | null = null
const listeners = new Set<() => void>()
let watching = false

/**
 * Another tab's change arrives as its `storage` event, which drops the cache so the next read
 * comes from the store. One listener for the module's life, so a tab away from the reading page
 * still has a fresh answer when it comes back.
 */
function watch(): void {
  if (watching) return
  watching = true
  window.addEventListener('storage', (e) => {
    // `key === null` is `clear()`.
    if (e.key !== null && e.key !== KEY) return
    cached = null
    for (const listener of listeners) listener()
  })
}

/** What the store holds: a JSON array of ids. Anything else is no folder closed. */
function parse(raw: string | null): ReadonlySet<string> {
  if (raw === null) return NONE
  try {
    const value: unknown = JSON.parse(raw)
    if (!Array.isArray(value)) return NONE
    return new Set(value.filter((id): id is string => typeof id === 'string'))
  } catch {
    return NONE
  }
}

function read(): string | null {
  try {
    return localStorage.getItem(KEY)
  } catch {
    return null
  }
}

/** The folders closed on this device: one answer until this tab or another changes it. */
export function closedFolders(): ReadonlySet<string> {
  watch()
  cached ??= parse(read())
  return cached
}

/** Open or close a folder on this device, and tell whoever is listening. */
export function setFolderOpen(id: string, open: boolean): void {
  const closed = closedFolders()
  if (closed.has(id) === !open) return
  const next = new Set(closed)
  if (open) next.delete(id)
  else next.add(id)
  // Oldest first, as a Set keeps them: the ones past the bound are the longest closed.
  const kept = [...next].slice(-CLOSED_MAX)
  cached = new Set(kept)
  try {
    localStorage.setItem(KEY, JSON.stringify(kept))
  } catch {}
  for (const listener of listeners) listener()
}

/** Open a closed folder or close an open one, as it is when this runs, not when it was bound. */
export function toggleFolder(id: string): void {
  setFolderOpen(id, closedFolders().has(id))
}

/** Hear this tab's changes, made through `setFolderOpen`, and another tab's, heard by `watch`. */
export function subscribeFolders(listener: () => void): () => void {
  watch()
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** The folders closed on this device, kept as they change. A server render has every one open. */
export function useClosedFolders(): ReadonlySet<string> {
  return useSyncExternalStore(subscribeFolders, closedFolders, () => NONE)
}

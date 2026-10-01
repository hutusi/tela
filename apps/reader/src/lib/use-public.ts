/**
 * A public page's data, fetched from tela-api's edge-cacheable JSON. Kept for this visit, so going
 * back to Discover is a render, not a request; a page the edge rendered hands its data over in
 * `#tela-data`, so the first render needs no request either.
 */
import { useEffect, useState } from 'react'

const held = new Map<string, unknown>()
/**
 * Pages changed this visit: fetched past the browser's cache, which keeps a copy a minute and then
 * serves it stale while it asks again, for a day (a profile, four minutes more).
 */
const changed = new Set<string>()
const listeners = new Set<(prefix: string) => void>()

/**
 * The data the edge rendered this page with, if it was this path and the page has not been
 * forgotten since: the handover stays in the document for the whole visit, and after a change it
 * says what the page said before it.
 */
function handedOver(path: string): unknown {
  if ([...changed].some((prefix) => path.startsWith(prefix))) return undefined
  const el = typeof document === 'undefined' ? null : document.getElementById('tela-data')
  if (!el) return undefined
  try {
    const data = JSON.parse(el.textContent ?? '') as { path: string; body: unknown }
    if (data.path === path) return data.body
  } catch {}
  return undefined
}

export type Loaded<T> = { status: 'loading' } | { status: 'missing' } | { status: 'ready'; data: T }

const LOADING = { status: 'loading' } as const
const MISSING = { status: 'missing' } as const

/** What a path shows before its own answer: what is held this visit, else loading. */
function initial<T>(path: string | null, handover: boolean): Loaded<T> {
  if (path === null) return MISSING
  const data = held.get(path) ?? (handover ? handedOver(path) : undefined)
  return data === undefined ? LOADING : { status: 'ready', data: data as T }
}

/** `null` is a page that cannot exist (a malformed id): missing, with no request. */
export function usePublic<T>(path: string | null): Loaded<T> {
  // The state says which path it is for, and is shown only for that path. A page mounted across
  // paths (one profile, then another) renders the new path before any effect runs, and the router
  // commits that render in a transition: checked in an effect, the last path's data would paint
  // under the new address.
  const [state, setState] = useState<{ path: string | null; loaded: Loaded<T> }>(() => ({
    path,
    loaded: initial<T>(path, true),
  }))
  // How often this path was forgotten while shown. Counted per path: a page that stays mounted
  // across paths (one profile, then another) starts each at 0, so the next shows loading rather
  // than the last one's data until its own answer comes.
  const [bump, setBump] = useState<{ path: string | null; n: number }>({ path, n: 0 })
  const version = bump.path === path ? bump.n : 0
  useEffect(() => {
    const listener = (prefix: string) => {
      if (path?.startsWith(prefix)) setBump((b) => ({ path, n: (b.path === path ? b.n : 0) + 1 }))
    }
    listeners.add(listener)
    return () => void listeners.delete(listener)
  }, [path])
  // A bumped `version` asks for a fresh copy.
  useEffect(() => {
    if (path === null) {
      setState({ path, loaded: MISSING })
      return
    }
    let cancelled = false
    const known = initial<T>(path, version === 0)
    // A refetch of the path on screen keeps showing it until the answer comes.
    setState((s) =>
      known === LOADING && version !== 0 && s.path === path ? s : { path, loaded: known },
    )
    const stale = [...changed].some((prefix) => path.startsWith(prefix))
    // The edge's handover is at most five minutes old, and the browser's own copy can be older:
    // after one, the browser asks tela-api before it answers (`no-cache`), so the page on screen
    // is never replaced by an older one. A page changed this visit is fetched past the copy.
    const handover = version === 0 && !held.has(path) && handedOver(path) !== undefined
    const cache: 'reload' | 'no-cache' | null = stale ? 'reload' : handover ? 'no-cache' : null
    fetch(path, { credentials: 'same-origin', ...(cache ? { cache } : {}) })
      .then(async (res) => {
        if (cancelled) return
        if (res.status === 404) {
          setState({ path, loaded: MISSING })
          return
        }
        if (!res.ok) return
        const data = (await res.json()) as T
        held.set(path, data)
        if (!cancelled) setState({ path, loaded: { status: 'ready', data } })
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [path, version])
  return state.path === path ? state.loaded : initial<T>(path, false)
}

/** Forget pages' data after changing them: what shows them now fetches again, and so does a visit. */
export function forgetPublic(prefix: string): void {
  for (const key of held.keys()) if (key.startsWith(prefix)) held.delete(key)
  changed.add(prefix)
  for (const listener of listeners) listener(prefix)
}

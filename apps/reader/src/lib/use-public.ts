/**
 * A public page's data, fetched from tela-api's edge-cacheable JSON. Kept for this visit, so going
 * back to Discover is a render, not a request; a page the edge rendered hands its data over in
 * `#tela-data`, so the first render needs no request either.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'

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

/**
 * Still loading, and `failed` once the request has (offline, an error), with `retry` to ask again:
 * a page says so with Try again (`LoadFailed`) in its skeleton's place, and one with something
 * better to show can show it. Coming back online asks again by itself.
 */
export type Loaded<T> =
  | { status: 'loading'; failed?: undefined }
  | { status: 'loading'; failed: true; retry: () => void }
  | { status: 'missing' }
  | { status: 'ready'; data: T }

const LOADING = { status: 'loading' } as const
const FAILED = { status: 'loading', failed: true } as const
const MISSING = { status: 'missing' } as const

/** What the hook keeps: a failure without its `retry`, which is the hook's own. */
type Held<T> = Exclude<Loaded<T>, { failed: true }> | typeof FAILED

/** What a path shows before its own answer: what is held this visit, else loading. */
function initial<T>(path: string | null, handover: boolean): Held<T> {
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
  const [state, setState] = useState<{ path: string | null; loaded: Held<T> }>(() => ({
    path,
    loaded: initial<T>(path, true),
  }))
  // How often this path was forgotten or retried while shown. Counted per path: a page that stays
  // mounted across paths (one profile, then another) starts each at 0, so the next shows loading
  // rather than the last one's data until its own answer comes.
  const [bump, setBump] = useState<{ path: string | null; n: number }>({ path, n: 0 })
  const version = bump.path === path ? bump.n : 0
  const again = useCallback(
    () => setBump((b) => ({ path, n: (b.path === path ? b.n : 0) + 1 })),
    [path],
  )
  useEffect(() => {
    const listener = (prefix: string) => {
      if (path?.startsWith(prefix)) again()
    }
    listeners.add(listener)
    return () => void listeners.delete(listener)
  }, [path, again])
  // A bumped `version` asks for a fresh copy.
  useEffect(() => {
    if (path === null) {
      setState({ path, loaded: MISSING })
      return
    }
    let cancelled = false
    const known = initial<T>(path, version === 0)
    // A refetch of the path on screen keeps showing it until the answer comes; one that had
    // failed shows its skeleton again while it asks, so Try again is seen to do something.
    setState((s) =>
      known === LOADING && version !== 0 && s.path === path && s.loaded !== FAILED
        ? s
        : { path, loaded: known },
    )
    const stale = [...changed].some((prefix) => path.startsWith(prefix))
    // The edge's handover is at most five minutes old, and the browser's own copy can be older:
    // after one, the browser asks tela-api before it answers (`no-cache`), so the page on screen
    // is never replaced by an older one. A page changed this visit is fetched past the copy.
    const handover = version === 0 && !held.has(path) && handedOver(path) !== undefined
    const cache: 'reload' | 'no-cache' | null = stale ? 'reload' : handover ? 'no-cache' : null
    // A refetch that fails leaves what the page shows; only a page still loading hears of it.
    const fail = () => {
      if (cancelled) return
      setState((s) =>
        s.path === path && s.loaded.status === 'loading' ? { path, loaded: FAILED } : s,
      )
    }
    fetch(path, { credentials: 'same-origin', ...(cache ? { cache } : {}) })
      .then(async (res) => {
        if (cancelled) return
        if (res.status === 404) {
          setState({ path, loaded: MISSING })
          return
        }
        if (!res.ok) {
          fail()
          return
        }
        const data = (await res.json()) as T
        held.set(path, data)
        if (!cancelled) setState({ path, loaded: { status: 'ready', data } })
      })
      .catch(fail)
    return () => {
      cancelled = true
    }
  }, [path, version])
  const shown = state.path === path ? state.loaded : initial<T>(path, false)
  const failed = shown.status === 'loading' && shown.failed === true
  // Back online, a page that failed asks again by itself, as the sync does.
  useEffect(() => {
    if (!failed) return
    window.addEventListener('online', again)
    return () => window.removeEventListener('online', again)
  }, [failed, again])
  // One object per path, so what depends on the answer changes only when the answer does.
  const withRetry = useMemo(() => ({ ...FAILED, retry: again }), [again])
  if (shown.status === 'loading' && shown.failed === true) return withRetry
  return shown
}

/** Try again, for a page whose answer failed to come; nothing while it is on its way or here. */
export function retryOf<T>(loaded: Loaded<T>): (() => void) | undefined {
  return loaded.status === 'loading' && loaded.failed ? loaded.retry : undefined
}

/** Forget pages' data after changing them: what shows them now fetches again, and so does a visit. */
export function forgetPublic(prefix: string): void {
  for (const key of held.keys()) if (key.startsWith(prefix)) held.delete(key)
  changed.add(prefix)
  for (const listener of listeners) listener(prefix)
}

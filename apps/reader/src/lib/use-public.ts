/**
 * A public page's data, fetched from tela-api's edge-cacheable JSON. Kept for this visit, so going
 * back to Discover is a render, not a request; a page the edge rendered hands its data over in
 * `#tela-data`, so the first render needs no request either.
 */
import { useEffect, useState } from 'react'

const held = new Map<string, unknown>()
/** Pages changed this visit: fetched past the browser's cache, which holds them a minute. */
const changed = new Set<string>()
const listeners = new Set<(prefix: string) => void>()

function handedOver(path: string): unknown {
  const el = typeof document === 'undefined' ? null : document.getElementById('tela-data')
  if (!el) return undefined
  try {
    const data = JSON.parse(el.textContent ?? '') as { path: string; body: unknown }
    if (data.path === path) return data.body
  } catch {}
  return undefined
}

export type Loaded<T> = { status: 'loading' } | { status: 'missing' } | { status: 'ready'; data: T }

/** `null` is a page that cannot exist (a malformed id): missing, with no request. */
export function usePublic<T>(path: string | null): Loaded<T> {
  const [state, setState] = useState<Loaded<T>>(() => {
    if (path === null) return { status: 'missing' }
    const data = held.get(path) ?? handedOver(path)
    return data === undefined ? { status: 'loading' } : { status: 'ready', data: data as T }
  })
  const [version, setVersion] = useState(0)
  useEffect(() => {
    const listener = (prefix: string) => {
      if (path?.startsWith(prefix)) setVersion((v) => v + 1)
    }
    listeners.add(listener)
    return () => void listeners.delete(listener)
  }, [path])
  // A bumped `version` asks for a fresh copy.
  useEffect(() => {
    if (path === null) {
      setState({ status: 'missing' })
      return
    }
    let cancelled = false
    const known = held.get(path) ?? (version === 0 ? handedOver(path) : undefined)
    if (known !== undefined) setState({ status: 'ready', data: known as T })
    else if (version === 0) setState({ status: 'loading' })
    const stale = [...changed].some((prefix) => path.startsWith(prefix))
    fetch(path, { credentials: 'same-origin', ...(stale ? { cache: 'reload' as const } : {}) })
      .then(async (res) => {
        if (cancelled) return
        if (res.status === 404) {
          setState({ status: 'missing' })
          return
        }
        if (!res.ok) return
        const data = (await res.json()) as T
        held.set(path, data)
        if (!cancelled) setState({ status: 'ready', data })
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [path, version])
  return state
}

/** Forget pages' data after changing them: what shows them now fetches again, and so does a visit. */
export function forgetPublic(prefix: string): void {
  for (const key of held.keys()) if (key.startsWith(prefix)) held.delete(key)
  changed.add(prefix)
  for (const listener of listeners) listener(prefix)
}

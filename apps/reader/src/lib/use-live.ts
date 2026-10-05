/**
 * A live RPC answer, for the few screens that read the server rather than the local store
 * (Settings → Invites and Account, the admin console): what a page shows there is counted by the
 * server or is someone else's, so no device holds it.
 */
import { useCallback, useEffect, useState } from 'react'

/**
 * Load once on mount, and again on `reload()`; a page left mid-call drops the answer. `load` must
 * keep its identity between renders (a module function, or `useCallback`), or every render loads
 * again. `error` is what the last load threw, for a caller that tells one failure from another
 * (the console's `NotAdmin`); `failed` is any failure, a null answer included.
 */
export function useLive<T>(load: (signal?: AbortSignal) => Promise<T | null>) {
  const [value, setValue] = useState<T | null>(null)
  const [failed, setFailed] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const reload = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const answer = await load(signal)
        if (signal?.aborted) return
        setValue(answer)
        setFailed(answer === null)
        setError(null)
      } catch (thrown) {
        // Signed out or another account: api() has told the session. Offline: say it failed.
        if (signal?.aborted) return
        setFailed(true)
        setError(thrown)
      }
    },
    [load],
  )
  useEffect(() => {
    const controller = new AbortController()
    void reload(controller.signal)
    return () => controller.abort()
  }, [reload])
  return { value, failed, error, reload }
}

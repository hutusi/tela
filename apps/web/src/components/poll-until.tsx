'use client'

import { useRouter } from 'next/navigation'
import { useEffect } from 'react'
import { createPollBudget } from '@/lib/poll-budget'

/**
 * Wait for a background job to change an open article — a body translation, or the full-text
 * fetch of a summary-only post — and refresh the page once, when it has.
 *
 * This replaces polling with `router.refresh()`, which re-rendered the whole three-pane page
 * every two seconds for up to three minutes: a sidebar aggregate, sixty list rows and the article
 * body, per tick, to learn that a translation was still running. Here a tick is one indexed row,
 * the interval backs off, and the expensive render happens exactly once.
 *
 * The window is measured in visible time, not wall-clock: a tab left in the background does not
 * spend it, and comes back to an immediate check rather than to a page frozen on "translating".
 */
export function PollUntil({
  articleId,
  lang,
  revision,
  startMs = 2000,
  maxIntervalMs = 30_000,
  maxMs = 180_000,
}: {
  articleId: number
  lang: string
  /** The revision this page was rendered from; a different one means it is worth re-rendering. */
  revision: string
  startMs?: number
  maxIntervalMs?: number
  maxMs?: number
}) {
  const router = useRouter()
  useEffect(() => {
    const controller = new AbortController()
    const url = `/api/reading/state?article=${articleId}&lang=${encodeURIComponent(lang)}`
    // Counts only the time this tab is actually in front of someone: a poller that skips its
    // request while hidden must not spend its window while hidden either.
    const budget = createPollBudget(maxMs)
    let timer: ReturnType<typeof setTimeout> | undefined
    let interval = startMs
    let stopped = false

    const clear = () => {
      if (timer) clearTimeout(timer)
      timer = undefined
    }

    const stop = () => {
      stopped = true
      clear()
      controller.abort()
    }

    const schedule = (delay = interval) => {
      if (stopped || budget.exhausted()) return stop()
      // A hidden tab is not waiting for anything anyone can see. Hold here; visibilitychange
      // resumes with an immediate check.
      if (document.hidden) return budget.pause()
      timer = setTimeout(tick, delay)
    }

    async function tick() {
      timer = undefined
      if (stopped || document.hidden) return schedule()
      try {
        const res = await fetch(url, { signal: controller.signal, cache: 'no-store' })
        if (res.ok) {
          const body = (await res.json()) as { revision?: unknown }
          if (typeof body.revision === 'string' && body.revision !== revision) {
            stop()
            router.refresh()
            return
          }
        }
      } catch {
        // A failed poll is not worth surfacing: the next tick tries again, and the reader can
        // always reload. Aborting on unmount lands here too.
      }
      interval = Math.min(interval * 1.5, maxIntervalMs)
      schedule()
    }

    const onVisibility = () => {
      if (stopped) return
      if (document.hidden) {
        budget.pause()
        clear()
        return
      }
      budget.resume()
      // The reader is looking again: check now, before carrying on with the backoff.
      if (!timer) schedule(0)
    }

    document.addEventListener('visibilitychange', onVisibility)
    schedule(startMs)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      stop()
    }
  }, [articleId, lang, revision, router, startMs, maxIntervalMs, maxMs])
  return null
}

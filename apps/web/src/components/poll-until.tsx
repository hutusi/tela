'use client'

import { useRouter } from 'next/navigation'
import { useEffect } from 'react'

/**
 * Wait for a background job to change an open article — a body translation, or the full-text
 * fetch of a summary-only post — and refresh the page once, when it has.
 *
 * This replaces polling with `router.refresh()`, which re-rendered the whole three-pane page
 * every two seconds for up to three minutes: a sidebar aggregate, sixty list rows and the article
 * body, per tick, to learn that a translation was still running. Here a tick is one indexed row,
 * the interval backs off, and the expensive render happens exactly once.
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
    const started = Date.now()
    const controller = new AbortController()
    const url = `/api/reading/state?article=${articleId}&lang=${encodeURIComponent(lang)}`
    let timer: ReturnType<typeof setTimeout> | undefined
    let interval = startMs
    let stopped = false

    const stop = () => {
      stopped = true
      if (timer) clearTimeout(timer)
      controller.abort()
    }

    const schedule = () => {
      if (stopped || Date.now() - started > maxMs) return stop()
      interval = Math.min(interval * 1.5, maxIntervalMs)
      timer = setTimeout(tick, interval)
    }

    async function tick() {
      if (stopped) return
      // A hidden tab is not waiting for anything anyone can see. Keep the cheap timer, skip the
      // request, and pick the change up on the tick after the reader comes back.
      if (document.hidden) return schedule()
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
      schedule()
    }

    timer = setTimeout(tick, startMs)
    return stop
  }, [articleId, lang, revision, router, startMs, maxIntervalMs, maxMs])
  return null
}

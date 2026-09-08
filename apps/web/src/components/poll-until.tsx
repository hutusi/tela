'use client'

import { useEffect } from 'react'
import { createPoller } from '@/lib/poller'

/**
 * Wait for a background job to change an open article — a body translation, or the full-text
 * fetch of a summary-only post — and refresh the page once, when it has.
 *
 * This replaces polling with `router.refresh()`, which re-rendered the whole three-pane page
 * every two seconds for up to three minutes: a sidebar aggregate, sixty list rows and the article
 * body, per tick, to learn that a translation was still running. Here a tick is one indexed row,
 * the interval backs off, and the expensive render happens exactly once.
 *
 * The loop itself lives in `lib/poller.ts`, where its rules about visible time and overlapping
 * reads can be tested against a clock instead of guessed at.
 *
 * What to do about a change is the caller's business: the reader re-fetches its own pane from a
 * route handler, which is far cheaper than the page render this used to trigger.
 */
export function PollUntil({
  articleId,
  lang,
  revision,
  onChanged,
  startMs = 2000,
  maxIntervalMs = 30_000,
  maxMs = 180_000,
}: {
  articleId: number
  lang: string
  /** The revision this page was rendered from; a different one means something has moved. */
  revision: string
  /** Called once, when it has. */
  onChanged: () => void
  startMs?: number
  maxIntervalMs?: number
  maxMs?: number
}) {
  useEffect(() => {
    const url = `/api/reading/state?article=${articleId}&lang=${encodeURIComponent(lang)}`
    const poller = createPoller({
      revision,
      startMs,
      maxIntervalMs,
      maxMs,
      hidden: () => document.hidden,
      read: async (signal) => {
        const res = await fetch(url, { signal, cache: 'no-store' })
        if (!res.ok) return null
        const body = (await res.json()) as { revision?: unknown }
        return typeof body.revision === 'string' ? body.revision : null
      },
      onChanged,
    })
    const onVisibility = () => poller.visibilityChanged()
    document.addEventListener('visibilitychange', onVisibility)
    poller.start()
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      poller.stop()
    }
  }, [articleId, lang, revision, onChanged, startMs, maxIntervalMs, maxMs])
  return null
}

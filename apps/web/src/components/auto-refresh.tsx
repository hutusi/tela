'use client'

import { useRouter } from 'next/navigation'
import { useEffect } from 'react'

/**
 * Re-render the server page on an interval, for a bounded time. Used while a freshly added
 * feed is being fetched by the worker so its articles appear without a manual reload.
 */
export function AutoRefresh({
  intervalMs = 3000,
  maxMs = 90_000,
}: {
  intervalMs?: number
  maxMs?: number
}) {
  const router = useRouter()
  useEffect(() => {
    const started = Date.now()
    const timer = setInterval(() => {
      if (Date.now() - started > maxMs) {
        clearInterval(timer)
        return
      }
      router.refresh()
    }, intervalMs)
    return () => clearInterval(timer)
  }, [router, intervalMs, maxMs])
  return null
}

'use client'

import { useLinkStatus } from 'next/link'

/**
 * A shimmer over the row whose link is being navigated to.
 *
 * The reading page is dynamic and has no `loading.tsx` — deliberately, because a route-level
 * fallback would blank the article list on every click. So a click gets its acknowledgement here
 * instead: the list stays put, and the row the reader chose says it is working.
 *
 * Must be rendered inside the `<Link>` it reports on; that is how `useLinkStatus` finds it.
 */
export function LinkPending() {
  const { pending } = useLinkStatus()
  if (!pending) return null
  return (
    <span
      aria-hidden
      data-testid="link-pending"
      className="pointer-events-none absolute inset-0 animate-pulse rounded-lg bg-ink/[0.045]"
    />
  )
}

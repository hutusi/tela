/**
 * A blogroll's page (ADR 0050), pure so the edge renders it too: a guest's view of a public
 * blogroll, a member's, and its owner's, which the page fills with its tools through the slots.
 * Layout by CSS alone (`max-md:`), since the edge has no media queries.
 *
 * STUB: slice 3 (the blogroll page) writes this view. The props are the contract the edge
 * (`ssr.tsx`) and the page (`pages/blogroll.tsx`) render it with.
 */
import type { ReactNode } from 'react'
import type { BlogrollBlog, BlogrollData, MemberControls } from './types'

/** What the owner's page puts into a row: its action (Remove) and its note, or the note editor. */
export type BlogrollRowSlots = { action?: ReactNode; note?: ReactNode; meta?: ReactNode }

export type BlogrollViewProps = {
  data: BlogrollData
  /** A signed-in visitor: their subscription state, and Subscribe on each row. */
  member?: MemberControls | undefined
  locale: string
  now: number
  /** The owner's tools under the title (Public, Edit, Add blogs, Copy link), and the Add blogs panel. */
  ownerHeader?: ReactNode
  /** The owner's slots for one row; given, the row shows them in place of Subscribe. */
  ownerRow?: (blog: BlogrollBlog) => BlogrollRowSlots
  /** The member's Subscribe to all, with its panel. Absent for a guest, who gets a sign-in link. */
  subscribe?: ReactNode
  /** Shown in place of the list when the blogroll has no blogs. */
  empty?: ReactNode
}

export function BlogrollView(_props: BlogrollViewProps) {
  return null
}

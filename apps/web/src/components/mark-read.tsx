'use client'

import { useEffect } from 'react'
import { markReadAction } from '@/app/reading/actions'

/**
 * Opening an article marks it read; done client-side so rendering stays a pure GET.
 *
 * Deliberately does not refresh: the render that follows a click already shows the open article
 * as read (ArticleList treats the selected id as read), and the sidebar's counts are corrected by
 * the next navigation. Refreshing here cost a second full render of the three-pane page — the
 * page whose latency budget is one database wave.
 */
export function MarkRead({ articleId, isRead }: { articleId: number; isRead: boolean }) {
  useEffect(() => {
    if (isRead) return
    markReadAction(articleId).catch(() => undefined)
  }, [articleId, isRead])
  return null
}

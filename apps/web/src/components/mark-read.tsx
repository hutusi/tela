'use client'

import { useRouter } from 'next/navigation'
import { useEffect } from 'react'
import { markReadAction } from '@/app/reading/actions'

/** Opening an article marks it read; done client-side so rendering stays a pure GET. */
export function MarkRead({ articleId, isRead }: { articleId: number; isRead: boolean }) {
  const router = useRouter()
  useEffect(() => {
    if (isRead) return
    let cancelled = false
    markReadAction(articleId).then(() => {
      if (!cancelled) router.refresh()
    })
    return () => {
      cancelled = true
    }
  }, [articleId, isRead, router])
  return null
}

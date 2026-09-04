'use client'

import { useRouter } from 'next/navigation'
import { useEffect } from 'react'
import { requestTranslationAction } from '@/app/reading/actions'

/** Ask the worker for a body translation as soon as a foreign article opens. */
export function RequestTranslation({
  articleId,
  targetLang,
}: {
  articleId: number
  targetLang: string
}) {
  const router = useRouter()
  useEffect(() => {
    let cancelled = false
    requestTranslationAction(articleId, targetLang).then(() => {
      if (!cancelled) router.refresh()
    })
    return () => {
      cancelled = true
    }
  }, [articleId, targetLang, router])
  return null
}

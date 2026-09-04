'use client'

import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { useEffect, useState } from 'react'
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
  const t = useTranslations('translation')
  const [rateLimited, setRateLimited] = useState(false)
  useEffect(() => {
    let cancelled = false
    requestTranslationAction(articleId, targetLang).then((outcome) => {
      if (cancelled) return
      if (outcome === 'rate_limited') setRateLimited(true)
      else router.refresh()
    })
    return () => {
      cancelled = true
    }
  }, [articleId, targetLang, router])
  if (!rateLimited) return null
  return (
    <p className="text-[13px] text-muted" data-testid="translation-rate-limited">
      {t('rateLimited')}
    </p>
  )
}

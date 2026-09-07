'use client'

import type { ReadingLanguage } from '@tela/shared'
import { useEffect } from 'react'
import { readingLangDocumentCookie } from '@/lib/reading-lang-cookie'

/** Repair a missing reading-language cache after the profile fallback answered this render. */
export function ReadingLangCookieSeed({ userId, lang }: { userId: string; lang: ReadingLanguage }) {
  useEffect(() => {
    // biome-ignore lint/suspicious/noDocumentCookie: Cookie Store is not available in every browser Tela supports.
    document.cookie = readingLangDocumentCookie(userId, lang)
  }, [userId, lang])
  return null
}

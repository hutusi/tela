'use client'

import { useTranslations } from 'next-intl'

/**
 * A block the translator could not do, keeping its source text and saying so.
 *
 * Both reading layouts need this: side by side has the original beside it, but translation-only
 * would otherwise show source-language paragraphs with nothing to explain them — the bar's count
 * says how many failed, never which. The label is a real element rather than generated content,
 * so it can be selected and is announced like any other text.
 */
export function Untranslated({ children }: { children: React.ReactNode }) {
  const t = useTranslations('translation')
  return (
    <div className="article-untranslated min-w-0">
      <span className="article-untranslated-label">{t('blockUntranslated')}</span>
      {children}
    </div>
  )
}

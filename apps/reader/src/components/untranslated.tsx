import { useTranslations } from 'use-intl'

/**
 * A block showing its source text in the translation's place, and saying why: the translator
 * could not do it, or its chunk has not landed yet. The label is a real element, so it can be
 * selected and is announced like any other text.
 */
export function Untranslated({
  pending = false,
  children,
}: {
  pending?: boolean
  children: React.ReactNode
}) {
  const t = useTranslations('translation')
  return (
    <div className="article-untranslated min-w-0" data-pending={pending ? '1' : undefined}>
      <span className="article-untranslated-label">
        {pending ? t('translating') : t('blockUntranslated')}
      </span>
      {children}
    </div>
  )
}

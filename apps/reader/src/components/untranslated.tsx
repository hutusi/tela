import { LANGUAGE_NAMES, type UiLocale } from '@tela/shared'
import { useLocale, useTranslations } from 'use-intl'

/**
 * A block showing its source text in the translation's place, and saying why: the translator
 * could not do it ("Not translated · Japanese"), or its chunk has not landed yet. The label is a
 * real element, so it can be selected and is announced like any other text; styles.css sets it in
 * capitals, which leaves the words themselves as written.
 */
export function Untranslated({
  pending = false,
  sourceLang,
  children,
}: {
  pending?: boolean
  sourceLang: string | undefined
  children: React.ReactNode
}) {
  const t = useTranslations('translation')
  const locale = useLocale()
  const names = LANGUAGE_NAMES[locale as UiLocale] ?? LANGUAGE_NAMES.en
  const language = (sourceLang && names[sourceLang]) || sourceLang || ''
  return (
    <div className="article-untranslated min-w-0" data-pending={pending ? '1' : undefined}>
      <span className="article-untranslated-label">
        {pending ? t('translating') : t('notTranslated', { language })}
      </span>
      {children}
    </div>
  )
}

/**
 * Translation mode's stand-in for the blocks still on their way (`translatedPrefix`): three grey
 * lines and what they are waiting for, rather than source text that would pass for a translation.
 */
export function TranslatingRest() {
  const t = useTranslations('translation')
  return (
    <div className="mb-5 mt-1 flex flex-col gap-3" data-testid="translating-rest">
      <div aria-hidden="true" className="h-[13px] w-[96%] rounded bg-hover" />
      <div aria-hidden="true" className="h-[13px] w-[88%] rounded bg-hover" />
      <div aria-hidden="true" className="h-[13px] w-[64%] rounded bg-hover" />
      <span className="text-[12.5px] text-muted">{t('translatingRest')}</span>
    </div>
  )
}

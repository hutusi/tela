import { READING_LANGUAGES } from '@tela/shared'
import { useTranslations } from 'use-intl'
import { pillLabel } from '../lib/format'
import { useStore } from '../store/hooks'
import { CONTROL } from './header-control'

/**
 * "Read in 中文 EN": two languages, both in view, one press to change. A member's sets the language
 * posts are translated into (their interface language is in Settings); a visitor's sets the
 * interface and, with it, the titles (`VisitorLocale`). Each language is in its own script, so a
 * reader who cannot read the page can still find theirs. The caller gives it its display and
 * shrink, since the visitor's is hidden below `sm`. Its text is 12px until `lg`, where the member's
 * header has the least room (DESIGN.md).
 */
export function ReadInPill<T extends string>({
  options,
  value,
  onChoose,
  className,
  testId,
}: {
  options: readonly T[]
  value: string
  onChoose: (code: T) => void
  className: string
  testId: string
}) {
  const t = useTranslations('nav')
  return (
    <div
      className={`${CONTROL} items-center gap-1 pr-[3px] pl-3 text-[12px] font-medium lg:gap-1.5 lg:text-[13px] ${className}`}
      data-testid={testId}
    >
      <span className="text-muted">{t('readIn')}</span>
      {options.map((code) => (
        <button
          key={code}
          type="button"
          lang={code}
          onClick={() => onChoose(code)}
          aria-pressed={code === value}
          data-testid={`${testId}-${code}`}
          className={`rounded-full px-2 py-[5px] whitespace-nowrap lg:px-2.5 ${code === value ? 'bg-ink text-paper' : 'text-ink-2 hover:bg-hover'}`}
        >
          {pillLabel(code)}
        </button>
      ))}
    </div>
  )
}

/** A member's "Read in": the language posts are translated into. The UI locale is in Settings. */
export function ReadInMenu({ readingLang }: { readingLang: string }) {
  const { store } = useStore()
  return (
    <ReadInPill
      options={READING_LANGUAGES}
      value={readingLang}
      onChoose={(code) => store.mutate({ type: 'setProfile', readingLang: code })}
      className="flex sm:shrink-0"
      testId="read-in"
    />
  )
}

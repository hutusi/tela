import { asLabel, LANGUAGE_NAMES, READING_LANGUAGES, type ReadingLanguage } from '@tela/shared'
import { useTranslations } from 'use-intl'
import { pillLabel } from '../lib/format'
import { useStore } from '../store/hooks'
import { CONTROL, MENU_PANEL, menuItem, useHeaderMenu } from './header-control'

/**
 * "Read in 简体 ▾": the one language control for every reader, a menu built as the theme menu is
 * (`useHeaderMenu`). Four languages do not fit in view at once, so the button names only the
 * current one, short (`pillLabel`), and the list names each in full, in its own script and its
 * own `lang`, so a reader who cannot read the page can still find theirs. A member's sets the
 * language posts are translated into (their interface language is in Settings); a visitor's sets
 * the interface and, with it, the titles (`VisitorLocale`). The caller gives it its display and
 * shrink, since the visitor's is hidden below `sm`. Its text is 12px until `lg`, where the
 * member's header has the least room (DESIGN.md).
 *
 * The edge's page marks the language it was rendered in, which is right for every visitor it is
 * cached for, since the cache is kept per language; choosing needs the script.
 */
export function ReadInMenu<T extends ReadingLanguage>({
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
  const { box, onToggle, close } = useHeaderMenu()
  return (
    <details ref={box} onToggle={onToggle} className={`relative ${className}`} data-testid={testId}>
      <summary
        className={`${CONTROL} flex cursor-pointer list-none items-center gap-1 whitespace-nowrap pr-2.5 pl-3 text-[12px] font-medium lg:gap-1.5 lg:text-[13px] [&::-webkit-details-marker]:hidden`}
      >
        {/* The spaces are for its name ("Read in EN"); the flex gap is what shows. */}
        <span className="text-muted">{t('readIn')}</span>{' '}
        <span lang={value} className="text-ink">
          {pillLabel(value)}
        </span>{' '}
        <span aria-hidden="true" className="text-[10px] text-muted">
          ▾
        </span>
      </summary>
      <div className={MENU_PANEL}>
        {options.map((code) => (
          <button
            key={code}
            type="button"
            lang={code}
            aria-pressed={code === value}
            onClick={() => {
              onChoose(code)
              close('outside')
            }}
            data-testid={`${testId}-${code}`}
            className={menuItem(code === value)}
          >
            {asLabel(LANGUAGE_NAMES[code][code] ?? code, code)}
          </button>
        ))}
      </div>
    </details>
  )
}

/** A member's "Read in": the language posts are translated into. The UI locale is in Settings. */
export function MemberReadIn({ readingLang }: { readingLang: string }) {
  const { store } = useStore()
  return (
    <ReadInMenu
      options={READING_LANGUAGES}
      value={readingLang}
      onChoose={(code) => store.mutate({ type: 'setProfile', readingLang: code })}
      className="sm:shrink-0"
      testId="read-in"
    />
  )
}

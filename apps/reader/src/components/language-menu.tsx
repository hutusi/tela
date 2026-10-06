import {
  asLabel,
  LANGUAGE_NAMES,
  READING_LANGUAGES,
  type ReadingLanguage,
  UI_LOCALES,
} from '@tela/shared'
import { useTranslations } from 'use-intl'
import { circleLabel } from '../lib/format'
import { useReadingLang, useStore } from '../store/hooks'
import { useUi } from '../ui'
import { CONTROL, MENU_PANEL, menuItem, useHeaderMenu } from './header-control'

/** A language as a reader looks for it: in its own name and script, as a label ("Français"). */
const endonym = (code: ReadingLanguage) => asLabel(LANGUAGE_NAMES[code][code] ?? code, code)

/**
 * The header's language circle (ADR 0040), for members, visitors and the sign-in page alike: a
 * 34px circle of the theme menu's family that shows the current language short (`circleLabel`:
 * 简, 繁, EN, FR), and a menu built as the theme menu is (`useHeaderMenu`) that names each of the
 * four in full, in its own script and `lang`, so a reader who cannot read the page can still find
 * theirs. The circle's accessible name says the whole name and what it sets ("Language:
 * 简体中文"). The caller gives it its display and shrink, since the visitor's is hidden below `sm`.
 *
 * The edge's page marks the language it was rendered in, which is right for every visitor it is
 * cached for, since the cache is kept per language; choosing needs the script.
 */
export function LanguageMenu<T extends ReadingLanguage>({
  options,
  value,
  onChoose,
  sets,
  className,
}: {
  options: readonly T[]
  value: T
  onChoose: (code: T) => void
  /** What a choice changes, as the circle's name says it. */
  sets: 'language' | 'translateInto'
  className: string
}) {
  const t = useTranslations('nav')
  const { box, onToggle, close } = useHeaderMenu()
  const label = circleLabel(value)
  return (
    <details
      ref={box}
      onToggle={onToggle}
      className={`relative ${className}`}
      data-testid="language-menu"
    >
      <summary
        className={`${CONTROL} flex w-[34px] cursor-pointer list-none items-center justify-center whitespace-nowrap font-medium text-ink ${label.length === 1 ? 'text-[14px]' : 'text-[11.5px] tracking-[.02em]'} [&::-webkit-details-marker]:hidden`}
      >
        <span aria-hidden="true" lang={value}>
          {label}
        </span>
        <span className="sr-only">{t(sets, { name: endonym(value) })}</span>
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
            data-testid={`language-menu-${code}`}
            className={menuItem(code === value)}
          >
            {endonym(code)}
          </button>
        ))}
      </div>
    </details>
  )
}

/** A member's circle: the language posts are translated into. The UI locale is in Settings. */
export function MemberLanguage() {
  const { store } = useStore()
  const { locale } = useUi()
  const readingLang = useReadingLang(locale)
  return (
    <LanguageMenu
      options={READING_LANGUAGES}
      value={readingLang}
      onChoose={(code) => store.mutate({ type: 'setProfile', readingLang: code })}
      sets="translateInto"
      className="shrink-0"
    />
  )
}

/**
 * A visitor's circle, in the header and on the sign-in page (ADR 0035): it sets the interface
 * language, and with it the language titles are translated into, since a visitor reads in their
 * interface language (`useReadingLang`). The choice is the `tela_locale` cookie, which the edge
 * renders by.
 */
export function VisitorLanguage({ className }: { className: string }) {
  const { locale, setLocale } = useUi()
  return (
    <LanguageMenu
      options={UI_LOCALES}
      value={locale}
      onChoose={setLocale}
      sets="language"
      className={className}
    />
  )
}

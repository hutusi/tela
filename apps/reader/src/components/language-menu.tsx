import {
  asLabel,
  isUiLocale,
  LANGUAGE_NAMES,
  READING_LANGUAGES,
  type ReadingLanguage,
  UI_LOCALES,
} from '@tela/shared'
import { Link } from 'react-router'
import { useTranslations } from 'use-intl'
import { circleLabel } from '../lib/format'
import { useReadingLang, useStore, useTables } from '../store/hooks'
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
 * `apart` is a member who chose a translation language of their own in Settings: the circle then
 * sets only that, and says so, in its name ("Translate into: English") and as the panel's title.
 * A member's panel also ends with a way to Settings → Language, linked or apart: it is where the
 * two are set apart, and linked again; a visitor has no Settings to go to.
 *
 * The edge's page marks the language it was rendered in, which is right for every visitor it is
 * cached for, since the cache is kept per language; choosing needs the script.
 */
export function LanguageMenu<T extends ReadingLanguage>({
  options,
  value,
  onChoose,
  apart = false,
  settings = false,
  className,
}: {
  options: readonly T[]
  value: T
  onChoose: (code: T) => void
  apart?: boolean
  settings?: boolean
  className: string
}) {
  const t = useTranslations('nav')
  const ts = useTranslations('settings')
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
        {/* The name in its own `lang`, so a screen reader says 简体中文 in a Chinese voice. */}
        <span className="sr-only">
          {t.rich(apart ? 'translateInto' : 'language', {
            name: endonym(value),
            lang: (chunks) => <span lang={value}>{chunks}</span>,
          })}
        </span>
      </summary>
      <div className={MENU_PANEL}>
        {apart ? (
          <p
            className="px-2.5 pt-1 pb-1.5 text-[11.5px] font-medium text-muted"
            data-testid="language-menu-title"
          >
            {ts('translateInto')}
          </p>
        ) : null}
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
        {settings ? (
          <>
            <div className="mx-1 my-1 border-t border-line" />
            <Link
              to="/settings/translation"
              onClick={() => close('outside')}
              data-testid="language-menu-settings"
              className={`${menuItem(false)} hover:no-underline`}
            >
              {t('languageSettings')}
            </Link>
          </>
        ) : null}
      </div>
    </details>
  )
}

/**
 * A member's circle. Linked, as an account is until Settings sets them apart (its reading language
 * null), a choice is the interface language, and the translation follows it; apart, a choice is
 * the translation language only. Which, is read when the choice is made, not when the menu
 * rendered: a sync may have linked them or set them apart in between, and the account's rows say
 * what a choice changes.
 */
export function MemberLanguage() {
  const { store } = useStore()
  const { locale, setLocale } = useUi()
  const readingLang = useReadingLang(locale)
  const apart = (useTables().profile?.readingLang ?? null) !== null
  const choose = (code: ReadingLanguage) => {
    const linked = (store.getSnapshot().tables.profile?.readingLang ?? null) === null
    if (linked && isUiLocale(code)) setLocale(code)
    else store.mutate({ type: 'setProfile', readingLang: code })
  }
  return apart ? (
    <LanguageMenu
      options={READING_LANGUAGES}
      value={readingLang}
      onChoose={choose}
      apart
      settings
      className="shrink-0"
    />
  ) : (
    <LanguageMenu
      options={UI_LOCALES}
      value={locale}
      onChoose={choose}
      settings
      className="shrink-0"
    />
  )
}

/**
 * A visitor's circle, in the header and on the sign-in page (ADR 0035): it sets the interface
 * language, and with it the language titles are translated into, since a visitor reads in their
 * interface language (`useReadingLang`). The choice is the `tela_locale` cookie, which the edge
 * renders by, and an account joining on this browser takes it (`localeToAdopt`).
 */
export function VisitorLanguage({ className }: { className: string }) {
  const { locale, setLocale } = useUi()
  return (
    <LanguageMenu options={UI_LOCALES} value={locale} onChoose={setLocale} className={className} />
  )
}

import { useTranslations } from 'use-intl'
import { pressThemeSwitch } from '../lib/typography'
import { useStore } from '../store/hooks'
import { Glyph, MOON, SUN } from './glyph'

/**
 * The header's sun and moon (ADR 0037), from `sm` up: one press puts the other theme on the page.
 * The glyph says where a press goes, the moon by day and the sun at night, and the stylesheet
 * chooses it, not React (`.light-only` and `.dark-only` in styles.css): the edge's cached page and
 * the first paint show the right one before any script runs, and the label inside each half goes
 * with its glyph. The page is read when the press comes, never remembered from a render.
 *
 * A member's press is their synced `ui.theme`, and the page shows what the store makes of it, as
 * Settings and the Aa menu do, so all three say the same and their other devices follow; a
 * visitor's goes on the page and stays on this device, and their account takes it when they join
 * (`pressThemeSwitch`, `themeToAdopt`). Going back to following the system is Settings' and the Aa
 * menu's: the switch only says light or dark.
 */
export function ThemeToggle() {
  const t = useTranslations('nav')
  const { store } = useStore()
  return (
    <button
      type="button"
      onClick={() => pressThemeSwitch(store)}
      data-testid="theme-toggle"
      className="hidden size-[34px] shrink-0 items-center justify-center rounded-full border border-line bg-surface text-muted hover:border-muted hover:text-ink sm:flex"
    >
      <span className="light-only">
        <Glyph className="block">{MOON}</Glyph>
        <span className="sr-only">{t('toDark')}</span>
      </span>
      <span className="dark-only">
        <Glyph className="block">{SUN}</Glyph>
        <span className="sr-only">{t('toLight')}</span>
      </span>
    </button>
  )
}

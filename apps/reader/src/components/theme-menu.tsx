import { useSyncExternalStore } from 'react'
import { useTranslations } from 'use-intl'
import { chooseTheme, pageTheme, THEMES, type Theme } from '../lib/typography'
import { useStore } from '../store/hooks'
import { AUTO, Glyph, MOON, SUN } from './glyph'
import { CONTROL, MENU_PANEL, menuItem, useHeaderMenu } from './header-control'
import { Segmented } from './segmented'

const GLYPHS: Record<Theme, React.ReactNode> = { system: AUTO, light: SUN, dark: MOON }

/** Re-read whenever anything puts another theme on the page: this menu, Settings, a sync. */
function onPageTheme(changed: () => void): () => void {
  const watch = new MutationObserver(changed)
  watch.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
  return () => watch.disconnect()
}

/**
 * The theme the page is set to, and choosing one, for each control outside Settings that offers
 * Auto, Light and Dark: the header's menu, and on a phone the account menu and the visitor's
 * footer, so none of them can write something the others do not. A member's choice is their
 * synced `ui.theme`, and the page shows what the store makes of it, as Settings does; a visitor's
 * goes on the page and stays on this device, and their account takes it when they join
 * (`chooseTheme`, `themeToAdopt`). `chosen` is null at the edge: its page is everyone's, so it
 * says no one's choice.
 */
export function useThemeChoice(): { chosen: Theme | null; choose: (theme: Theme) => void } {
  const { store } = useStore()
  const chosen = useSyncExternalStore(onPageTheme, pageTheme, () => null)
  return { chosen, choose: (theme) => chooseTheme(store, theme) }
}

/**
 * The header's theme menu (ADR 0037), from `sm` up: Auto, Light or Dark, as Settings and the Aa
 * menu offer them. Its 34px circle shows the choice, the half-filled circle for Auto, and the
 * stylesheet picks which (`.theme-is-*` in styles.css), not React: the edge's page is one cached
 * copy for every visitor, so it holds all three with their names, and the inline script's
 * `data-theme` shows the right one before any script of the app's runs. For the same reason the
 * edge marks no item as chosen; the app marks the one the page is set to. A native `<details>`,
 * as the language circle is (`useHeaderMenu`), so it opens before the script runs; choosing needs
 * the script, and writes what `useThemeChoice` says.
 */
export function ThemeMenu() {
  const t = useTranslations('nav')
  const ty = useTranslations('typography')
  const { chosen, choose } = useThemeChoice()
  const { box, onToggle, close } = useHeaderMenu()
  return (
    <details
      ref={box}
      onToggle={onToggle}
      className="relative hidden shrink-0 sm:block"
      data-testid="theme-menu"
    >
      <summary
        className={`${CONTROL} flex w-[34px] cursor-pointer list-none items-center justify-center text-muted hover:text-ink [&::-webkit-details-marker]:hidden`}
      >
        {THEMES.map((theme) => (
          <span key={theme} className={`theme-is-${theme}`}>
            <Glyph className="block">{GLYPHS[theme]}</Glyph>
            <span className="sr-only">{t('themeIs', { theme: ty(`themes.${theme}`) })}</span>
          </span>
        ))}
      </summary>
      <div className={MENU_PANEL}>
        {THEMES.map((theme) => (
          <button
            key={theme}
            type="button"
            aria-pressed={chosen === null ? undefined : chosen === theme}
            onClick={() => {
              choose(theme)
              close('outside')
            }}
            data-testid={`theme-menu-${theme}`}
            className={menuItem(chosen === theme)}
          >
            <Glyph className="block shrink-0 text-muted">{GLYPHS[theme]}</Glyph>
            {ty(`themes.${theme}`)}
          </button>
        ))}
      </div>
    </details>
  )
}

/**
 * The theme as a segmented control (Tela v5), where a phone has no room for the header's menu: a
 * row of the account menu, and the visitor's footer. It writes what the menu writes.
 */
export function ThemeSwitch({ label, testId }: { label: string; testId: string }) {
  const ty = useTranslations('typography')
  const { chosen, choose } = useThemeChoice()
  return (
    <Segmented
      label={label}
      options={THEMES}
      value={chosen}
      render={(theme) => ty(`themes.${theme}`)}
      onChoose={choose}
      testId={testId}
      large
    />
  )
}

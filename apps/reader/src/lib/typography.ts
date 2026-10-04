/**
 * How the member reads (ADR 0026): text size, line length and theme, kept as synced prefs so every
 * device reads the same way. Values are names, not numbers, so a pref from a later build that
 * this one does not know falls back to the default instead of rendering nonsense.
 */
import type { Tables } from '@tela/sync'

export const SIZES = { s: 0.88, m: 1, l: 1.13, xl: 1.27 } as const
export const MEASURES = { narrow: 560, normal: 640, wide: 760 } as const
export const THEMES = ['system', 'light', 'dark'] as const

export type Size = keyof typeof SIZES
export type Measure = keyof typeof MEASURES
export type Theme = (typeof THEMES)[number]

export const PREFS = { size: 'reader.size', measure: 'reader.measure', theme: 'ui.theme' } as const

export const pick = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
  allowed.includes(value as T) ? (value as T) : fallback

export function typographyOf(t: Tables): { size: Size; measure: Measure; theme: Theme } {
  return {
    size: pick(t.prefs.get(PREFS.size)?.value, Object.keys(SIZES) as Size[], 'm'),
    measure: pick(t.prefs.get(PREFS.measure)?.value, Object.keys(MEASURES) as Measure[], 'normal'),
    theme: pick(t.prefs.get(PREFS.theme)?.value, THEMES, 'system'),
  }
}

/** The reader pane's CSS variables for a size and measure. */
export const readerStyle = (size: Size, measure: Measure) =>
  ({
    '--reader-scale': SIZES[size],
    '--reader-measure': `${MEASURES[measure]}px`,
  }) as React.CSSProperties

const THEME_KEY = 'tela.theme'

/**
 * Put a theme on the page, and remember it on this device so the next visit's first paint (an
 * inline script in index.html, before any CSS or JS) is already right. `system` removes the
 * attribute and lets `prefers-color-scheme` decide.
 */
export function applyTheme(theme: Theme): void {
  const root = document.documentElement
  if (theme === 'system') delete root.dataset.theme
  else root.dataset.theme = theme
  try {
    localStorage.setItem(THEME_KEY, theme)
  } catch {}
}

const DARK = '(prefers-color-scheme: dark)'

/**
 * The theme the page shows now: its own choice, else the system's. Asked whenever it matters and
 * never kept, so a press answers for the page as it is, after Settings, the Aa menu or a sync
 * from another device has changed it.
 */
export function shownTheme(): 'light' | 'dark' {
  const chosen = document.documentElement.dataset.theme
  if (chosen === 'light' || chosen === 'dark') return chosen
  return window.matchMedia(DARK).matches ? 'dark' : 'light'
}

/**
 * Put the other theme on the page, and say which it was. Never `system`: the switch only says
 * light or dark, and going back to following the system is for Settings and the Aa menu.
 */
export function flipTheme(): 'light' | 'dark' {
  const next = shownTheme() === 'dark' ? 'light' : 'dark'
  applyTheme(next)
  return next
}

/** What this device last put on the page, as `applyTheme` kept it; `system` when it cannot say. */
export function deviceTheme(): Theme {
  try {
    return pick(localStorage.getItem(THEME_KEY), THEMES, 'system')
  } catch {
    return 'system'
  }
}

/**
 * The theme an account takes from this device once it is synced: the one its visitor chose here
 * before joining. Never over the account's own row, whatever that says, and nothing when the
 * device only follows the system, which an account without a row does already.
 */
export function themeToAdopt(t: Pick<Tables, 'prefs'>, device: Theme): 'light' | 'dark' | null {
  if (t.prefs.has(PREFS.theme) || device === 'system') return null
  return device
}

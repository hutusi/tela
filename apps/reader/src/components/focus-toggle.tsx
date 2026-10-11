import { useTranslations } from 'use-intl'
import { toggleFocus, useLayout } from '../lib/layout'

/**
 * Focus (ADR 0029): while an article is open, the list goes too and the article has the pane to
 * itself. From `lg`, where there is a list beside the article to hide; below it the list already
 * gives way to the reader. One label and a pressed state, as a toggle button has; `f` does the
 * same, and the choice is this device's.
 *
 * The key cap says F whether it is on or off (Tela v5 has "Exit focus" and Esc while on): here Esc
 * closes the article and the choice outlives it, so F is the key that turns it off.
 */
export function FocusToggle() {
  const t = useTranslations('reader')
  const tk = useTranslations('keys')
  const on = useLayout().focus === 'on'
  return (
    <button
      type="button"
      onClick={toggleFocus}
      aria-pressed={on}
      aria-keyshortcuts="f"
      title={tk('focus')}
      data-testid="focus-toggle"
      className="hidden items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 py-1.5 text-muted hover:bg-hover hover:text-ink aria-pressed:bg-hover aria-pressed:text-ink lg:inline-flex"
    >
      {t('focus')}
      {/* Out of the name, which is the label alone: aria-keyshortcuts says the key. */}
      <span aria-hidden="true" className="flex">
        <kbd className="rounded border border-b-2 border-line px-[5px] font-sans text-[11px] leading-[15px] text-muted">
          F
        </kbd>
      </span>
    </button>
  )
}

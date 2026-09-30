import { useTranslations } from 'use-intl'
import { toggleFocus, useLayout } from '../lib/layout'

/**
 * Focus (ADR 0029): while an article is open, the list goes too and the article has the pane to
 * itself. From `lg`, where there is a list beside the article to hide; below it the list already
 * gives way to the reader. One label and a pressed state, as a toggle button has; `f` does the
 * same, and the choice is this device's.
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
      title={tk('focus')}
      data-testid="focus-toggle"
      className="hidden whitespace-nowrap rounded-md px-2.5 py-1.5 text-muted hover:bg-hover hover:text-ink aria-pressed:bg-hover aria-pressed:text-ink lg:inline"
    >
      {t('focus')}
    </button>
  )
}

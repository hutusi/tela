import { useTranslations } from 'use-intl'
import { toggleSidebar, useLayout } from '../lib/layout'

/** A panel with its left third marked off: the sidebar, drawn here since Tela has no icon set. */
function PanelIcon() {
  return (
    <svg
      width={16}
      height={16}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2" />
      <path d="M6 2.75v10.5" />
    </svg>
  )
}

/**
 * Shows or hides the sidebar (ADR 0029), from `lg`, which is where there is one: below it the
 * filters live in `MobileNav`. It sits at the head of the list whichever state the sidebar is in,
 * so it is in one place to find; `[` does the same. `aria-expanded` without `aria-controls`: the
 * sidebar is not in the DOM while hidden, and an id that points at nothing is worse than none.
 */
export function SidebarToggle() {
  const t = useTranslations('sidebar')
  const shown = useLayout().sidebar === 'shown'
  const label = shown ? t('hide') : t('show')
  return (
    <button
      type="button"
      onClick={toggleSidebar}
      aria-expanded={shown}
      aria-label={label}
      title={label}
      data-testid="sidebar-toggle"
      className="-ml-2.5 hidden shrink-0 self-center rounded-md px-2.5 py-1.5 text-muted hover:bg-hover hover:text-ink lg:inline-flex"
    >
      <PanelIcon />
    </button>
  )
}

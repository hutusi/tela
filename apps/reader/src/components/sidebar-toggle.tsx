import { flushSync } from 'react-dom'
import { useTranslations } from 'use-intl'
import { toggleSidebar, useLayout } from '../lib/layout'

const ID = 'sidebar-toggle'

/**
 * The row the toggle heads, in the sidebar beside "Library" and at the top of its rail: one box for
 * both, so the toggle sits on the same line in either state and only moves sideways. Sticky, so a
 * long list never scrolls it away.
 */
export const TOGGLE_ROW =
  'sticky top-0 z-[1] flex h-[46px] shrink-0 items-center bg-paper pb-2.5 pt-5'

/**
 * A panel with its left third marked off: the sidebar, drawn here since Tela has no icon set. The
 * third is shaded while the sidebar is shown, so the glyph says which state it is in.
 */
function PanelIcon({ open }: { open: boolean }) {
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
      {open ? (
        <path
          d="M3.75 2.75H6v10.5H3.75a2 2 0 0 1-2-2v-6.5a2 2 0 0 1 2-2Z"
          fill="currentColor"
          fillOpacity={0.2}
          stroke="none"
        />
      ) : null}
      <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2" />
      <path d="M6 2.75v10.5" />
    </svg>
  )
}

/**
 * Shows or hides the sidebar, and a toggle that had focus keeps it. The toggle is in a different
 * place in each state, so the one pressed is gone once the change renders: `flushSync` renders it
 * now, and the handler then reads the page it made rather than remembering anything for later.
 */
export function toggleSidebarKeepingFocus(): void {
  const had = document.activeElement?.id === ID
  flushSync(toggleSidebar)
  if (had) document.getElementById(ID)?.focus()
}

/**
 * Shows or hides the sidebar (ADR 0029), from `lg`, which is where there is one: below it the
 * filters live in `MobileNav`. It heads the sidebar beside "Library", and the rail the sidebar
 * collapses to (ADR 0030); `[` does the same. One instance is mounted at a time, hence the id.
 * `aria-expanded` without `aria-controls`: the two are different elements, and whichever the
 * toggle would point at is not in the DOM once it has done its work.
 */
export function SidebarToggle({ className = '' }: { className?: string }) {
  const t = useTranslations('sidebar')
  const shown = useLayout().sidebar === 'shown'
  const label = shown ? t('hide') : t('show')
  return (
    <button
      type="button"
      id={ID}
      onClick={toggleSidebarKeepingFocus}
      aria-expanded={shown}
      aria-label={label}
      title={label}
      data-testid="sidebar-toggle"
      className={`hidden shrink-0 self-center rounded-md px-2.5 py-1.5 text-muted hover:bg-hover hover:text-ink lg:inline-flex ${className}`}
    >
      <PanelIcon open={shown} />
    </button>
  )
}

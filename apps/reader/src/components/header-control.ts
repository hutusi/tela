import { type SyntheticEvent, useEffect, useRef, useState } from 'react'
import { usePopover } from '../lib/use-popover'

/**
 * The controls on the header's right are one family (DESIGN.md): 34px tall and round, on
 * `surface`, in a `line` border that darkens on hover. The search link, the theme menu and the
 * language circle are 34px circles of it. Each adds its own display and shrink, since a caller
 * may hide it below `sm`, where the controls stay shrinkable.
 */
export const CONTROL = 'h-[34px] rounded-full border border-line bg-surface hover:border-muted'

/**
 * The panel a menu opens 6px under its control: `surface` in a `line` border, 10px corners, the
 * menu's lift, over everything but the header (z 7). Right-aligned to the control unless `left`,
 * at least `minWidth` wide (a literal class, so Tailwind sees it), and with `scroll` a long list
 * stops at 360px and scrolls. One class list per panel, so no two utilities set one property.
 */
export function menuPanel({
  left = false,
  minWidth = 'min-w-[160px]',
  scroll = false,
}: {
  left?: boolean
  minWidth?: string
  scroll?: boolean
} = {}): string {
  return [
    'absolute top-[calc(100%+6px)] z-[7] flex animate-fade flex-col rounded-[10px] border border-line bg-surface p-1.5 shadow-menu',
    left ? 'left-0' : 'right-0',
    minWidth,
    scroll ? 'max-h-[min(360px,60vh)] overflow-y-auto' : '',
  ].join(' ')
}

/** A header menu's panel: 160px, right-aligned to its control. */
export const MENU_PANEL = menuPanel()

/** What every menu's item shares; each adds its layout and its colour. */
export const MENU_ITEM = 'rounded-md px-2.5 py-[7px] text-left text-[13px] hover:bg-hover'

/** One choice in a header menu; the one the page holds is on the hover ground. */
export const menuItem = (on: boolean) =>
  `flex items-center gap-2.5 ${MENU_ITEM} text-ink ${on ? 'bg-hover font-medium' : ''}`

/**
 * A header menu is a native `<details>`, so it opens in the edge's page before any script runs;
 * choosing needs the script, and closes it. A click elsewhere, focus leaving it or Esc closes it
 * too, and Esc hands focus back to its summary (`usePopover`). Discover's language menu is one.
 */
export function useHeaderMenu() {
  const box = useRef<HTMLDetailsElement>(null)
  // Whether it is open, as the element says: it opens without React, from its summary.
  const [open, setOpen] = useState(false)
  const summary = () => box.current?.querySelector('summary')
  const shut = () => {
    if (box.current) box.current.open = false
  }
  // Only while open: its Esc is taken before anything else's, a dialog's included.
  usePopover(open, shut, box, summary)
  const close = (by: 'escape' | 'outside') => {
    shut()
    if (by === 'escape') summary()?.focus()
  }
  // React hears that it opened from the toggle event, which comes a task later, and `usePopover`
  // listens only once that render is in: an Esc pressed in between found nothing listening and
  // left the menu open. Until React knows, Esc reads the element itself as it is pressed.
  const known = useRef(open)
  known.current = open
  useEffect(() => {
    const onEscape = (e: KeyboardEvent) => {
      const el = box.current
      if (e.key !== 'Escape' || known.current || !el?.open) return
      e.preventDefault()
      el.open = false
      el.querySelector('summary')?.focus()
    }
    document.addEventListener('keydown', onEscape, true)
    return () => document.removeEventListener('keydown', onEscape, true)
  }, [])
  const onToggle = (e: SyntheticEvent<HTMLDetailsElement>) => setOpen(e.currentTarget.open)
  return { box, onToggle, close }
}

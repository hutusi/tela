import { type SyntheticEvent, useRef, useState } from 'react'
import { useDismiss } from '../lib/use-dismiss'

/**
 * The controls on the header's right are one family (DESIGN.md): 34px tall and round, on
 * `surface`, in a `line` border that darkens on hover. The search link and the theme menu are
 * circles of it, the Read-in menu a pill. Each adds its own display and shrink, since a caller
 * may hide it below `sm`, where the controls stay shrinkable.
 */
export const CONTROL = 'h-[34px] rounded-full border border-line bg-surface hover:border-muted'

/** The panel a header menu opens under its control: 160px of `surface`, right-aligned to it. */
export const MENU_PANEL =
  'absolute right-0 top-[calc(100%+6px)] z-[7] flex min-w-[160px] animate-fade flex-col rounded-[10px] border border-line bg-surface p-1.5 shadow-[0_8px_24px_rgba(0,0,0,.08)]'

/** One choice in a header menu; the one the page holds is on the hover ground. */
export const menuItem = (on: boolean) =>
  `flex items-center gap-2.5 rounded-md px-2.5 py-[7px] text-left text-[13px] text-ink hover:bg-hover ${on ? 'bg-hover font-medium' : ''}`

/**
 * A header menu is a native `<details>`, so it opens in the edge's page before any script runs;
 * choosing needs the script, and closes it. A click elsewhere, focus leaving it or Esc closes it
 * too, and Esc hands focus back to its summary (`useDismiss`).
 */
export function useHeaderMenu() {
  const box = useRef<HTMLDetailsElement>(null)
  // Whether it is open, as the element says: it opens without React, from its summary.
  const [open, setOpen] = useState(false)
  const close = (by: 'escape' | 'outside') => {
    const details = box.current
    if (!details) return
    details.open = false
    if (by === 'escape') details.querySelector('summary')?.focus()
  }
  // Only while open: its Esc is taken before anything else's, a dialog's included.
  useDismiss(open, close, box)
  const onToggle = (e: SyntheticEvent<HTMLDetailsElement>) => setOpen(e.currentTarget.open)
  return { box, onToggle, close }
}

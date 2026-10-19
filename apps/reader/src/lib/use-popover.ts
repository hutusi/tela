/**
 * How a popover closes, the same everywhere (DESIGN.md): a click elsewhere, focus leaving it, or
 * Esc (`useDismiss`, which takes Esc before the page's own). Esc gives focus back to what opened
 * it, so a keyboard reader carries on from there rather than from <body>; a click elsewhere leaves
 * focus where the click put it. What opened it is `opener`, when the popover has one control that
 * does, else whatever held focus as it opened (a highlight's note opens from a list's button, or
 * from a click on the text).
 *
 * The box should hold the control that opens it, as a header menu's `<details>` holds its summary:
 * a press on that control is then not a click elsewhere, which would close the popover on the
 * mousedown for its click to open it again.
 */
import { type RefObject, useLayoutEffect, useRef } from 'react'
import { useDismiss } from './use-dismiss'

export function usePopover(
  open: boolean,
  close: () => void,
  box: RefObject<HTMLElement | null>,
  opener?: () => HTMLElement | null | undefined,
): void {
  const before = useRef<HTMLElement | null>(null)
  // As it opens, before anything in it takes focus (a field focused in an effect: every layout
  // effect runs before any of those).
  useLayoutEffect(() => {
    if (!open) return
    const active = document.activeElement
    before.current = active instanceof HTMLElement && active !== document.body ? active : null
  }, [open])
  useDismiss(
    open,
    (by) => {
      close()
      if (by !== 'escape') return
      const back = opener?.() ?? before.current
      if (back?.isConnected) back.focus()
    },
    box,
  )
}

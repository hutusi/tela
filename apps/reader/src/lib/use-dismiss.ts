/**
 * Close a popover on a click outside it, on focus moving out of it (Tab past its last control), or
 * on Esc. Esc is taken in the capture phase and marked handled, so it closes the popover and only
 * the popover: the reader's own Esc closes the article. A popover left open behind the focus would
 * take the next Esc meant for the page.
 */
import { type RefObject, useEffect, useRef } from 'react'

export function useDismiss(
  open: boolean,
  /** Esc says so: a keyboard close hands focus back to the button, a click elsewhere keeps it. */
  close: (by: 'escape' | 'outside') => void,
  box: RefObject<HTMLElement | null>,
): void {
  // The latest close, without re-listening every render for a new closure.
  const latest = useRef(close)
  latest.current = close
  useEffect(() => {
    if (!open) return
    const outside = (e: Event) => {
      if (box.current && !box.current.contains(e.target as Node)) latest.current('outside')
    }
    const onEscape = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      latest.current('escape')
    }
    document.addEventListener('mousedown', outside)
    document.addEventListener('focusin', outside)
    document.addEventListener('keydown', onEscape, true)
    return () => {
      document.removeEventListener('mousedown', outside)
      document.removeEventListener('focusin', outside)
      document.removeEventListener('keydown', onEscape, true)
    }
  }, [open, box])
}

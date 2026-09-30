/**
 * Close a popover on a click outside it, or on Esc. Esc is taken in the capture phase and marked
 * handled, so it closes the popover and only the popover: the reader's own Esc closes the article,
 * and it leaves a key another handler has already used alone.
 */
import { type RefObject, useEffect, useRef } from 'react'

export function useDismiss(
  open: boolean,
  close: () => void,
  box: RefObject<HTMLElement | null>,
): void {
  // The latest close, without re-listening every render for a new closure.
  const latest = useRef(close)
  latest.current = close
  useEffect(() => {
    if (!open) return
    const outside = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) latest.current()
    }
    const onEscape = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      latest.current()
    }
    document.addEventListener('mousedown', outside)
    document.addEventListener('keydown', onEscape, true)
    return () => {
      document.removeEventListener('mousedown', outside)
      document.removeEventListener('keydown', onEscape, true)
    }
  }, [open, box])
}

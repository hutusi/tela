/**
 * A bar fixed at the foot of the screen puts its height in `--bottom-bar` on the root while it
 * shows, so what floats above it (the toast, the highlight toolbar) and the page's own foot clear
 * it. One bar shows at a time: the reader's on an open article, first run's Start on an empty list.
 */
import { type RefObject, useLayoutEffect } from 'react'

export function useBottomBar(bar: RefObject<HTMLElement | null>) {
  useLayoutEffect(() => {
    const el = bar.current
    if (!el) return
    const root = document.documentElement
    const measure = () => root.style.setProperty('--bottom-bar', `${el.offsetHeight}px`)
    measure()
    // The safe area, and so the bar's padding, changes as the phone turns.
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => {
      observer.disconnect()
      root.style.removeProperty('--bottom-bar')
    }
  }, [bar])
}

/**
 * A media query as React state, for what CSS alone cannot do: render one control or another rather
 * than hide one, where both would share a test id or a role, or where showing it has effects (the
 * phone reader's bottom bar sets `--bottom-bar`).
 */
import { useCallback, useSyncExternalStore } from 'react'

/** Below Tailwind's `lg` (64rem): the list gives way to the article, and a phone's bars show. */
export const BELOW_LG = 'not all and (min-width: 64rem)'

/**
 * Below Tailwind's `md` (48rem): a page's phone layout (Tela Mobile 10–16), where one set of
 * controls gives way to another, as the Settings list does to its side column.
 */
export const BELOW_MD = 'not all and (min-width: 48rem)'

export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const list = window.matchMedia(query)
      list.addEventListener('change', onChange)
      return () => list.removeEventListener('change', onChange)
    },
    [query],
  )
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => false,
  )
}

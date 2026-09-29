/** Page-wide UI state that is not synced data: the UI locale, which a signed-out visitor has too. */
import type { UiLocale } from '@tela/shared'
import { createContext, useContext } from 'react'

export type Ui = { locale: UiLocale; setLocale(locale: UiLocale): void }

export const UiContext = createContext<Ui | null>(null)

export function useUi(): Ui {
  const ui = useContext(UiContext)
  if (!ui) throw new Error('useUi outside UiContext')
  return ui
}

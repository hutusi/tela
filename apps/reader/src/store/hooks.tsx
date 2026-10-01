/** React's way into the local store: one context, and `useSyncExternalStore` over it. */
import { READING_LANGUAGES, type ReadingLanguage } from '@tela/shared'
import type { Tables } from '@tela/sync'
import { createContext, useContext, useEffect, useState, useSyncExternalStore } from 'react'
import type { SyncEngine } from './engine'
import type { LocalStore } from './local'
import type { Objects } from './objects'

export type StoreHandle = { store: LocalStore; engine: SyncEngine; objects: Objects }

const StoreContext = createContext<StoreHandle | null>(null)

export function StoreProvider({
  value,
  children,
}: {
  value: StoreHandle
  children: React.ReactNode
}) {
  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>
}

export function useStore(): StoreHandle {
  const handle = useContext(StoreContext)
  if (!handle) throw new Error('useStore outside StoreProvider')
  return handle
}

/** The tables the UI renders: confirmed rows with the member's pending changes on top. */
export function useTables(): Tables {
  const { store } = useStore()
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot).tables
}

/**
 * Whom the member follows as the server has confirmed it (`LocalStore.confirmedFollowees`): a
 * string, so it changes identity only when the confirmed follows do.
 */
export function useConfirmedFollowees(): string {
  const { store } = useStore()
  return useSyncExternalStore(store.subscribe, store.confirmedFollowees, store.confirmedFollowees)
}

/** The clock, ticking once a minute: relative times and "today" move without a render storm. */
export function useNow(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(id)
  }, [])
  return now
}

/** The language posts are translated into: the member's choice, else the UI's. */
export function useReadingLang(uiLocale: string): ReadingLanguage {
  const tables = useTables()
  const chosen = tables.profile?.readingLang
  if (chosen && (READING_LANGUAGES as readonly string[]).includes(chosen)) {
    return chosen as ReadingLanguage
  }
  return (READING_LANGUAGES as readonly string[]).includes(uiLocale)
    ? (uiLocale as ReadingLanguage)
    : 'en'
}

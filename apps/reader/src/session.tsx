/**
 * Who is reading. A device that holds a member's rows, and knows whose, renders them at once,
 * before any network (that is the point of the local store); the first pull confirms the session,
 * and a 401 from any sync call ends it and wipes the device's copy while it is still that
 * member's.
 */
import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import { AccountChanged, api, SignedOut, UpgradeRequired } from './store/api'
import type { SyncEngine } from './store/engine'
import type { LocalStore } from './store/local'

export type SessionStatus = 'unknown' | 'member' | 'guest'

type Session = {
  status: SessionStatus
  /**
   * After a sign-in: learn who, and start syncing. True when the tab held another account, in
   * which case the page is being loaded afresh at `next` and the caller has nothing left to do.
   */
  signedIn(next: string): Promise<boolean>
  signOut(): Promise<void>
}

const SessionContext = createContext<Session | null>(null)

export function useSession(): Session {
  const s = useContext(SessionContext)
  if (!s) throw new Error('useSession outside SessionProvider')
  return s
}

/** The engine reports a lost session through this; the provider decides what it means. */
export const sessionEvents = { signedOut: () => {} }

async function whoAmI(): Promise<string | null> {
  try {
    const res = await api('/api/v1/me')
    if (!res.ok) return null
    return ((await res.json()) as { id: string }).id
  } catch (err) {
    if (err instanceof SignedOut) return null
    throw err
  }
}

/** A signed-out session that never changes: the edge renders public pages for guests with it. */
export function GuestSession({ children }: { children: React.ReactNode }) {
  const guest: Session = { status: 'guest', signedIn: async () => false, signOut: async () => {} }
  return <SessionContext.Provider value={guest}>{children}</SessionContext.Provider>
}

export function SessionProvider({
  store,
  engine,
  children,
}: {
  store: LocalStore
  engine: SyncEngine
  children: React.ReactNode
}) {
  // Rows alone are not enough: whose they are is what every call names.
  const [status, setStatus] = useState<SessionStatus>(
    store.hasData && store.userId !== null ? 'member' : 'unknown',
  )

  useEffect(() => {
    sessionEvents.signedOut = () => {
      void store.forgetAccount().then(() => setStatus('guest'))
    }
  }, [store])

  useEffect(() => {
    if (status === 'member') {
      engine.start()
      return () => engine.stop()
    }
    if (status === 'unknown') {
      let cancelled = false
      whoAmI()
        .then(async (id) => {
          if (cancelled) return
          if (id) {
            await store.setUser(id)
            setStatus('member')
          } else setStatus('guest')
        })
        // Offline with nothing on the device: there is nothing to read, so show the public side.
        .catch(() => !cancelled && setStatus('guest'))
      return () => {
        cancelled = true
      }
    }
    return undefined
  }, [status, engine, store])

  const signedIn = useCallback(
    async (next: string) => {
      const id = await whoAmI()
      if (!id) return false
      if (await store.setUser(id)) {
        // This tab held someone else (their mail's link opened here): a fresh page, so nothing
        // the old account's page held in memory is shown as the new one's.
        window.location.assign(next)
        return true
      }
      // Already a member here, so the engine runs and nothing starts it again: catch up at once,
      // in case the claim had to wipe a copy taken from under this tab.
      if (status === 'member') void engine.pull()
      setStatus('member')
      return false
    },
    [store, engine, status],
  )

  const signOut = useCallback(async () => {
    engine.stop()
    // One request names this tab's account and ends the session, so tela-api can refuse it when
    // another tab has since signed in as someone else: a stale tab must not end their session.
    // Refused, api() has already sent this tab to start again as them; there is nothing to add.
    try {
      await api('/api/auth/sign-out', { method: 'POST', body: {} })
    } catch (err) {
      if (err instanceof AccountChanged || err instanceof UpgradeRequired) return
      // Offline, or signed out already: this tab forgets its account either way.
    }
    await store.clear()
    // A fresh page rather than a state change: the page a member leaves from may be one only
    // members see, whose gate would send them to sign in again, and nothing this visit held in
    // memory should outlive the session.
    window.location.assign('/')
  }, [engine, store])

  return (
    <SessionContext.Provider value={{ status, signedIn, signOut }}>
      {children}
    </SessionContext.Provider>
  )
}

/**
 * Who is reading. A device that holds a member's rows renders them at once, before any network
 * (that is the point of the local store); the first pull confirms the session, and a 401 from any
 * sync call ends it and wipes the device's copy.
 */
import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import { api, SignedOut } from './store/api'
import type { SyncEngine } from './store/engine'
import type { LocalStore } from './store/local'

export type SessionStatus = 'unknown' | 'member' | 'guest'

type Session = {
  status: SessionStatus
  /** After a sign-in: learn who, and start syncing. */
  signedIn(): Promise<void>
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
  const guest: Session = { status: 'guest', signedIn: async () => {}, signOut: async () => {} }
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
  const [status, setStatus] = useState<SessionStatus>(store.hasData ? 'member' : 'unknown')

  useEffect(() => {
    sessionEvents.signedOut = () => {
      void store.clear().then(() => setStatus('guest'))
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

  const signedIn = useCallback(async () => {
    const id = await whoAmI()
    if (!id) return
    await store.setUser(id)
    setStatus('member')
  }, [store])

  const signOut = useCallback(async () => {
    engine.stop()
    await fetch('/api/auth/sign-out', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
      credentials: 'same-origin',
    }).catch(() => undefined)
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

/**
 * Who is reading. A device that holds a member's rows, and knows whose, renders them at once,
 * before any network (that is the point of the local store); the first pull confirms the session,
 * and a 401 from any sync call ends it and wipes the device's copy while it is still that
 * member's.
 */
import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import { AccountChanged, api, SignedOut, UpgradeRequired } from './store/api'
import { earlierBuildRan, type Persistence } from './store/db'
import type { SyncEngine } from './store/engine'
import { LocalStore } from './store/local'

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

/** This tab's record of an account it left but could not forget (main.tsx), for one boot. */
const DISTRUSTED = 'tela.distrusted'

/** Do not trust `owner`'s stored copy on this tab's next boot: ask who is signed in first. */
export function distrust(owner: string): void {
  try {
    sessionStorage.setItem(DISTRUSTED, owner)
  } catch {
    // No sessionStorage: the next boot trusts the copy, and is refused again at its first call.
  }
}

/** Whether this tab left `owner` without forgetting it; asking also forgets the record. */
export function distrusted(owner: string | null): boolean {
  try {
    const left = sessionStorage.getItem(DISTRUSTED)
    sessionStorage.removeItem(DISTRUSTED)
    return left !== null && left === owner
  } catch {
    return false
  }
}

/** How a tab boots: as its stored copy's member, unless it holds no one, or no one to trust. */
export function initialStatus(
  store: Pick<LocalStore, 'hasData' | 'userId' | 'unverified'>,
): SessionStatus {
  const trusted = store.hasData && store.userId !== null && !store.unverified
  return trusted && !distrusted(store.userId) ? 'member' : 'unknown'
}

/**
 * Open the device's store for this boot. An earlier build having run on this device since (a tab
 * left open across the deploy, a rollback) marks the copy unverified in storage, so no tab and
 * no later boot trusts it until a claim after /me: a sign-out or sign-in there never reached it.
 */
export async function openStore(
  persistence: Persistence,
  ran: () => Promise<boolean> = earlierBuildRan,
): Promise<LocalStore> {
  const store = new LocalStore(persistence)
  await store.open()
  if (await ran()) await store.distrust()
  return store
}

/**
 * The session ended (a 401): forget this tab's account. A copy that could not be forgotten is
 * not trusted at the next boot, as when leaving.
 */
export async function forgetOnSignOut(store: Pick<LocalStore, 'userId' | 'forgetAccount'>) {
  const owner = store.userId
  await store.forgetAccount().catch(() => {
    if (owner !== null) distrust(owner)
  })
}

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
  // Rows alone are not enough: whose they are is what every call names. A copy this tab has
  // just left without forgetting is not trusted either; the claim after /me replaces it.
  const [status, setStatus] = useState<SessionStatus>(() => initialStatus(store))

  useEffect(() => {
    sessionEvents.signedOut = () => {
      void forgetOnSignOut(store).finally(() => setStatus('guest'))
    }
  }, [store])

  useEffect(() => {
    if (status === 'member') {
      engine.start()
      return () => engine.stop()
    }
    if (status === 'unknown') {
      let cancelled = false
      const again = () => setStatus('unknown')
      whoAmI()
        .then(async (id) => {
          if (cancelled) return
          if (id) {
            await store.setUser(id)
            setStatus('member')
          } else {
            // Nobody is signed in: a copy this tab still holds is no one's to show.
            await forgetOnSignOut(store)
            setStatus('guest')
          }
        })
        // Offline, with nothing on the device it can trust: the public side, until the network
        // is back and /me can say who this is.
        .catch(() => {
          if (cancelled) return
          setStatus('guest')
          window.addEventListener('online', again, { once: true })
        })
      return () => {
        cancelled = true
        window.removeEventListener('online', again)
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

/**
 * Who is reading. A device that holds a member's rows, and knows whose, renders them at once,
 * before any network (that is the point of the local store); the first pull confirms the session,
 * and a 401 from any sync call ends it and wipes the device's copy while it is still that
 * member's.
 */
import { type ProfileRow, readingLangOf } from '@tela/sync'
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { detectLocale } from './i18n'
import { AccountChanged, api, SignedOut, UpgradeRequired } from './store/api'
import { type EarlierBuild, earlierBuild, type Persistence } from './store/db'
import type { SyncEngine } from './store/engine'
import { LocalStore } from './store/local'

export type SessionStatus = 'unknown' | 'member' | 'guest'

/**
 * What a sign-in made of the tab. `reloading`: it held another account, and the page is being
 * loaded afresh at `next`. `waiting`: /me could not say as whom yet, and the session turns member
 * once it can. Otherwise the caller goes on to `next` itself.
 */
export type SignedIn = 'member' | 'guest' | 'waiting' | 'reloading'

type Session = {
  status: SessionStatus
  /** Whether /me could not be reached, and the tab is asking again. */
  retrying: boolean
  /** After a sign-in: learn who, and start syncing. */
  signedIn(next: string): Promise<SignedIn>
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
  const trusted = store.hasData && store.userId !== null && store.unverified === null
  return trusted && !distrusted(store.userId) ? 'member' : 'unknown'
}

/**
 * Open the device's store for this boot. An earlier build having run on this device since (a tab
 * left open across the deploy, a rollback) marks the copy unverified in storage, so no tab and
 * no later boot trusts it until a claim after /me: a sign-out or sign-in there never reached it.
 *
 * Tabs boot side by side, so the order is what makes it hold. The mark is down before the
 * earlier build's copy is emptied, and the copy is loaded after both: a tab that finds it already
 * emptied by another loads after that tab's mark. It is marked again once emptied, since a
 * sign-out there between the look and the emptying is known then only to this tab, and a claim
 * another tab makes meanwhile, on a /me asked before that sign-out, clears only the first mark.
 * Until that second mark is down, the emptied copy still reads as touched, so a tab that looks
 * in between marks the copy itself; and one that dies in between leaves it touched.
 *
 * `onRestart` hears every start-over from here on, a copy that does not load first among them.
 */
export async function openStore(
  persistence: Persistence,
  earlier: EarlierBuild = earlierBuild,
  onRestart: LocalStore['onRestart'] = null,
): Promise<LocalStore> {
  if (await earlier.wrote()) {
    await persistence.distrust()
    const emptied = await earlier.empty()
    if (emptied !== null) {
      await persistence.distrust()
      await earlier.seen(emptied)
    }
  }
  const store = new LocalStore(persistence)
  store.onRestart = onRestart
  await store.open()
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

/**
 * How long /me may take before the question counts as a miss. One that never settles (a request
 * held at the edge, a half-open connection) would otherwise leave nothing asking again.
 */
export const ME_DEADLINE = 15_000

/**
 * Who the session is, as /me says it: the account's id, and the two languages its profile holds
 * (null while it has none), so a device that holds nothing of the account yet knows which
 * language's titles to ask its first snapshot for.
 */
export type Me = { id: string; profile: Pick<ProfileRow, 'readingLang' | 'uiLocale'> | null }

/** A language the profile /me sent holds, or null for none, or for anything that is not one. */
const languageIn = (profile: Record<string, unknown>, key: 'readingLang' | 'uiLocale') => {
  const value = profile[key]
  return typeof value === 'string' ? value : null
}

/**
 * Who the session is, or null when nobody is signed in, which only a 401 says. Any other answer
 * rejects, since it says nothing about the session: a 5xx mid-deploy, a captive portal's page, a
 * WAF challenge, no network at all, or no answer within `deadline`.
 */
export async function whoAmI(deadline = ME_DEADLINE): Promise<Me | null> {
  let res: Response
  try {
    res = await api('/api/v1/me', { signal: AbortSignal.timeout(deadline) })
  } catch (err) {
    if (err instanceof SignedOut) return null
    throw err
  }
  if (!res.ok) throw new Error(`/api/v1/me answered ${res.status}`)
  const { id, profile } = (await res.json()) as { id?: unknown; profile?: unknown }
  if (typeof id !== 'string' || !id) throw new Error('/api/v1/me named no one')
  if (typeof profile !== 'object' || profile === null) return { id, profile: null }
  const held = profile as Record<string, unknown>
  return {
    id,
    profile: {
      readingLang: languageIn(held, 'readingLang'),
      uiLocale: languageIn(held, 'uiLocale'),
    },
  }
}

/**
 * The page's interface language as the app first renders it (`Routed`): the cookie's, else the
 * browser's. What a member reads in when their account names neither language.
 */
function pageLocale(): string {
  try {
    return detectLocale(document.cookie ?? '', navigator.languages ?? [navigator.language])
  } catch {
    return 'en'
  }
}

/** What asking /me made of the tab; null when a later question took over before it could act. */
export type Learned = 'member' | 'guest' | 'unreachable' | null

/**
 * Ask /me, and make the device say what it answered: the member's id claims the copy, and nobody
 * forgets it. No answer forgets nothing: the tab shows the public side, keeps the copy and its
 * unsent changes, and asks again (`whenReachable`); so does a claim the device's storage refused.
 * An answer that comes once `current()` is false changes nothing: a sign-in in this tab has asked
 * since, and its answer is the newer one.
 *
 * A device that holds nothing of the member's yet takes the language they read in from /me's
 * profile, so its first snapshot brings that language's titles alone, not every language's first
 * and the reading one's after. One that holds their rows reads it from its own profile row, as
 * the app hands it over (`Routed`), which counts a choice still on its way.
 */
export async function learnWho(
  store: Pick<
    LocalStore,
    'userId' | 'unverified' | 'mark' | 'setUser' | 'forgetAccount' | 'hasData' | 'setReadingLang'
  >,
  current: () => boolean,
  ask: () => Promise<Me | null> = whoAmI,
  locale: () => string = pageLocale,
): Promise<Learned> {
  // The mark as the question leaves: the answer reflects whatever that mark is about.
  const seen = await store.mark().catch(() => store.unverified)
  let me: Me | null
  try {
    me = await ask()
  } catch {
    return current() ? 'unreachable' : null
  }
  if (!current()) return null
  if (me === null) {
    // Nobody is signed in: a copy this tab still holds is no one's to show.
    await forgetOnSignOut(store)
    return 'guest'
  }
  try {
    await store.setUser(me.id, seen)
  } catch {
    return 'unreachable'
  }
  // Asked again while setUser ran (a sign-in's question took over): that answer names the language.
  if (!current()) return null
  if (!store.hasData) store.setReadingLang(readingLangOf(me.profile, locale()))
  return 'member'
}

/**
 * How long a tab that could not reach /me waits before its `attempt`th question again: 2 s,
 * doubling to 2 min.
 */
export const retryDelay = (attempt: number) => Math.min(2000 * 2 ** (attempt - 1), 120_000)

/**
 * Call `again` once, when /me may answer: after `delay`, or sooner when the browser comes back
 * online or the tab into view. Returns what cancels it.
 */
export function whenReachable(again: () => void, delay: number): () => void {
  const fire = () => {
    stop()
    again()
  }
  const shown = () => {
    if (document.visibilityState === 'visible') fire()
  }
  const timer = setTimeout(fire, delay)
  window.addEventListener('online', fire)
  document.addEventListener('visibilitychange', shown)
  const stop = () => {
    clearTimeout(timer)
    window.removeEventListener('online', fire)
    document.removeEventListener('visibilitychange', shown)
  }
  return stop
}

/** The longest signing out waits for the changes still unsent to go (`SyncEngine.flush`). */
export const SIGN_OUT_FLUSH_MS = 3000

/** A signed-out session that never changes: the edge renders public pages for guests with it. */
export function GuestSession({ children }: { children: React.ReactNode }) {
  const guest: Session = {
    status: 'guest',
    retrying: false,
    signedIn: async () => 'guest',
    signOut: async () => {},
  }
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
  // The status as last rendered, for what an answer does whenever it arrives.
  const shown = useRef(status)
  shown.current = status
  // The account whose rows this page has shown, what an answer is compared with to know whether
  // the page must be loaded afresh. Not the store's account: a claim the device refused has
  // already moved that on to the new one, while the page still holds the old one's.
  const displayed = useRef(status === 'member' ? store.userId : null)
  // While /me cannot be reached: the next question's place in a row of misses. Its own state,
  // not a status, since the question outlives the switch to the public side; and a new object
  // for every miss, so each one sets the next question even when the count is the same.
  const [retry, setRetry] = useState<{ attempt: number } | null>(null)
  // Where a sign-in that could not learn its account yet goes once a retry has.
  const after = useRef<string | null>(null)
  // The boot, each retry and each sign-in ask /me; only the latest question acts on its answer,
  // so an answer that left before a sign-in cannot forget the copy that sign-in has claimed.
  const asked = useRef(0)
  const ask = useCallback(() => {
    const turn = ++asked.current
    return learnWho(store, () => asked.current === turn)
  }, [store])

  /**
   * Act on what a question made of the tab, the same whichever asked it. `showing` is the account
   * whose rows the page showed when it asked (a member's, or nobody's); a claim for anyone else
   * loads a fresh page at `next`, so nothing that account's page held in memory is shown as the
   * new one's.
   */
  const settle = useCallback(
    (learned: Learned, showing: string | null, next: string): SignedIn => {
      if (learned === null) return 'waiting'
      if (learned === 'unreachable') {
        // The public side while it asks again, whichever question missed: a tab left 'unknown'
        // renders nothing at all.
        setStatus((s) => (s === 'unknown' ? 'guest' : s))
        return 'waiting'
      }
      setRetry(null)
      after.current = null
      if (learned === 'guest') {
        displayed.current = null
        setStatus('guest')
        return 'guest'
      }
      if (showing !== null && showing !== store.userId) {
        window.location.assign(next)
        return 'reloading'
      }
      displayed.current = store.userId
      // Already a member here, so the engine runs and nothing starts it again: catch up at once,
      // in case the claim had to wipe a copy taken from under this tab.
      if (shown.current === 'member') void engine.pull()
      setStatus('member')
      return 'member'
    },
    [store, engine],
  )
  const showing = useCallback(() => (shown.current === 'member' ? displayed.current : null), [])

  useEffect(() => {
    sessionEvents.signedOut = () => {
      displayed.current = null
      void forgetOnSignOut(store).finally(() => setStatus('guest'))
    }
  }, [store])

  useEffect(() => {
    if (status === 'member') {
      engine.start()
      return () => engine.stop()
    }
    if (status === 'unknown') {
      void ask().then((learned) => {
        if (learned === 'unreachable') setRetry((r) => ({ attempt: (r?.attempt ?? 0) + 1 }))
        // Nothing was shown before this answer: whoever it names, the page need not reload.
        settle(learned, null, '/')
      })
    }
    return undefined
  }, [status, engine, ask, settle])

  useEffect(() => {
    if (retry === null) return undefined
    return whenReachable(() => {
      const was = showing()
      void ask().then((learned) => {
        if (learned === 'unreachable') setRetry({ attempt: retry.attempt + 1 })
        settle(learned, was, after.current ?? location.pathname + location.search)
      })
    }, retryDelay(retry.attempt))
  }, [retry, ask, settle, showing])

  const signedIn = useCallback(
    async (next: string) => {
      const was = showing()
      const learned = await ask()
      if (learned === 'unreachable') {
        // Signed in, but not yet told as whom: ask again soon, from the first delay, and go on
        // to `next` then.
        after.current = next
        setRetry({ attempt: 1 })
      }
      return settle(learned, was, next)
    },
    [ask, settle, showing],
  )

  const signOut = useCallback(async () => {
    // What the member did last goes first, a change held for an Undo included, since forgetting
    // the account drops whatever is unsent. Not for long: offline, signing out goes on without.
    const epoch = store.epoch
    await engine.flush(SIGN_OUT_FLUSH_MS)
    // A push was told that another tab signed in as someone else (api() has sent this tab to
    // start again as them), or that the session had ended (the tab has forgotten the account):
    // a sign-out now would name no one, and could end the other account's session.
    if (store.epoch !== epoch) return
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
    <SessionContext.Provider value={{ status, retrying: retry !== null, signedIn, signOut }}>
      {children}
    </SessionContext.Provider>
  )
}

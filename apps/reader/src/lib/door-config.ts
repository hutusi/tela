/**
 * What the front door offers, as tela-api says (`/api/v1/public/auth`): Google and GitHub once
 * their apps are configured (ADR 0036), and whether joining needs an invite code (ADR 0056). Asked
 * each time a sheet opens and once as the app starts, never built into the shell, since the
 * operator flips the sign-up switch while a cached shell lives on; remembered on the device, so
 * the next sheet shows the last answer at once and the fresh one a moment later. tela-api keeps
 * the answer a minute in the browser's cache. Whatever the sheet shows, the server's gate decides.
 */
import { SIGNUP_MODES, type SignupMode } from '@tela/shared'
import { useEffect, useSyncExternalStore } from 'react'

export const PROVIDERS = ['google', 'github'] as const
export type Provider = (typeof PROVIDERS)[number]

/** Whether joining needs a code, and while it does not, whether today's places are all taken. */
export type Signup = { mode: SignupMode; paused: boolean }

export type DoorConfig = {
  providers: Provider[]
  /** Null until this device has heard: the sheet then shows what an invite-only Tela needs. */
  signup: Signup | null
}

/** The providers tela-api offers, as last heard on this device. */
const PROVIDERS_KEY = 'tela.auth-providers'
/** The sign-up switch, as last heard on this device. */
const SIGNUP_KEY = 'tela.signup'

function remembered(key: string): unknown {
  try {
    return JSON.parse(localStorage.getItem(key) ?? 'null')
  } catch {
    return null
  }
}

function remember(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Not remembered: the next sheet asks again before it shows it.
  }
}

/** A sign-up switch as tela-api words it, or null for anything else. */
export function readSignup(value: unknown): Signup | null {
  if (typeof value !== 'object' || value === null) return null
  const { signup, mode, paused } = value as Record<string, unknown>
  const said = signup ?? mode
  if (!SIGNUP_MODES.some((m) => m === said)) return null
  return { mode: said as SignupMode, paused: said === 'open' && paused === true }
}

function heard(): DoorConfig {
  const kept = remembered(PROVIDERS_KEY)
  return {
    providers: PROVIDERS.filter((p) => Array.isArray(kept) && kept.includes(p)),
    signup: readSignup(remembered(SIGNUP_KEY)),
  }
}

let current: DoorConfig | null = null
const listeners = new Set<() => void>()
/** The door's offer as this tab holds it now, outside React. */
export const doorConfig = (): DoorConfig => snapshot()
const snapshot = (): DoorConfig => {
  current ??= heard()
  return current
}

function set(next: Partial<DoorConfig>): void {
  current = { ...snapshot(), ...next }
  if (next.providers) remember(PROVIDERS_KEY, next.providers)
  if (next.signup) remember(SIGNUP_KEY, next.signup)
  for (const listener of listeners) listener()
}

/** Bumped by each refusal that said what the switch is, which no older answer may overwrite. */
let learned = 0
/** Whether the browser's copy of the answer is older than what a refusal said. */
let stale = false

/**
 * What a refusal just said of the switch: an invite code needed after all, or the day full. The
 * sheet follows it at once rather than wait for its next question, and the next question asks
 * past the browser's copy, which may be the minute-old answer the refusal contradicted.
 */
export function learnSignup(signup: Signup): void {
  learned++
  stale = true
  set({ signup })
}

let asking: Promise<void> | null = null

/**
 * Ask tela-api again. A 404 is a tela-api that predates the endpoint, which offers neither
 * provider and needs a code; anything else that fails keeps what the device last heard.
 */
export function askDoorConfig(): Promise<void> {
  if (asking) return asking
  const since = learned
  const cache: RequestCache = stale ? 'no-cache' : 'default'
  stale = false
  asking = fetch('/api/v1/public/auth', { credentials: 'same-origin', cache })
    .then(async (res) => {
      const fresh = since === learned
      if (res.status === 404) {
        return set({
          providers: [],
          ...(fresh ? { signup: { mode: 'invite', paused: false } } : {}),
        })
      }
      if (!res.ok) return
      const body = (await res.json()) as Record<string, unknown>
      const signup = readSignup(body)
      set({
        providers: PROVIDERS.filter((p) => body[p] === true),
        ...(signup && fresh ? { signup } : {}),
      })
    })
    .catch(() => {})
    .finally(() => {
      asking = null
    })
  return asking
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** The door's offer, asked again whenever a component using it mounts. */
export function useDoorConfig(): DoorConfig {
  const config = useSyncExternalStore(subscribe, snapshot, snapshot)
  useEffect(() => {
    void askDoorConfig()
  }, [])
  return config
}

/** When the next UTC day begins, and with it a new day's places (`signup.maxPerDay`). */
export function nextUtcMidnight(now: number): number {
  const day = 86_400_000
  return Math.floor(now / day) * day + day
}

/** Whether joining needs no invite code right now, as this device last heard. */
export function useOpenSignup(): boolean {
  return useDoorConfig().signup?.mode === 'open'
}

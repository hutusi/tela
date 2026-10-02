/**
 * Talking to tela-api (through tela-web's `/api/*` forward, same origin). Three answers change
 * what the app does rather than what it shows, so they become errors of their own: 401 means the
 * session is gone, 409 `upgrade` means this cached app is older than the protocol, and 409
 * `account_changed` means another tab signed in as someone else.
 *
 * Every call names the account the tab holds (tela-api refuses a member call that names anyone
 * but the session's), and the two 409s reach the handlers `bindApi` gave, whichever call met
 * them: a page that shows its own error for a failed call cannot swallow them.
 */
import { CLIENT_HEADER, MEMBER_HEADER, MIN_CLIENT } from '@tela/sync'

/** The protocol version this build speaks (ADR 0025); tela-api refuses older ones with 409. */
export const CLIENT_VERSION = MIN_CLIENT

export class SignedOut extends Error {
  override name = 'SignedOut'
}
export class UpgradeRequired extends Error {
  override name = 'UpgradeRequired'
}
export class AccountChanged extends Error {
  override name = 'AccountChanged'
}

export type ApiBinding = {
  /** The account the tab holds, named on every call; null while it holds none. */
  member(): string | null
  /** The session is someone else's than the account the tab holds. */
  accountChanged(): void
  /** This app is older than the protocol tela-api speaks. */
  upgrade(): void
}

let binding: ApiBinding = { member: () => null, accountChanged() {}, upgrade() {} }

/** Say who the tab holds and what to do when a call finds that out of date (main.tsx). */
export function bindApi(next: ApiBinding): void {
  binding = next
}

export type ApiInit = {
  method?: string
  body?: unknown
  /** Sent as the body verbatim, instead of JSON: OPML as text, a picture as a Blob of its type. */
  raw?: string | Blob
  signal?: AbortSignal
  /** Outlive the page: a push sent as the tab goes away still arrives. */
  keepalive?: boolean
  /** The account to name instead of the bound one: the engine's, as it was when it asked. */
  member?: string | null
}

export async function api(path: string, init: ApiInit = {}): Promise<Response> {
  const member = init.member === undefined ? binding.member() : init.member
  const headers: Record<string, string> = { [CLIENT_HEADER]: String(CLIENT_VERSION) }
  if (init.body !== undefined) headers['content-type'] = 'application/json'
  if (init.raw instanceof Blob && init.raw.type) headers['content-type'] = init.raw.type
  if (member) headers[MEMBER_HEADER] = member
  const res = await fetch(path, {
    method: init.method ?? (init.body === undefined && init.raw === undefined ? 'GET' : 'POST'),
    headers,
    credentials: 'same-origin',
    cache: 'no-store',
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    ...(init.raw !== undefined ? { body: init.raw } : {}),
    ...(init.signal ? { signal: init.signal } : {}),
    ...(init.keepalive ? { keepalive: true } : {}),
  })
  if (res.status === 401) throw new SignedOut()
  if (res.status === 409) {
    const body = (await res
      .clone()
      .json()
      .catch(() => null)) as { error?: string } | null
    if (body?.error === 'upgrade') {
      binding.upgrade()
      throw new UpgradeRequired()
    }
    if (body?.error === 'account_changed') {
      // Only news while the tab still holds the account it named: after a sign-in in this tab,
      // an answer to a call made before it is merely late.
      if (member === binding.member()) binding.accountChanged()
      throw new AccountChanged()
    }
  }
  return res
}

export async function apiJson<T>(
  path: string,
  init: ApiInit = {},
): Promise<{ status: number; body: T }> {
  const res = await api(path, init)
  const body = (await res.json().catch(() => null)) as T
  return { status: res.status, body }
}

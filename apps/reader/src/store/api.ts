/**
 * Talking to tela-api (through tela-web's `/api/*` forward, same origin). Two answers change what
 * the app does rather than what it shows, so they become errors of their own: 401 means the
 * session is gone, 409 `upgrade` means this cached app is older than the protocol.
 */
import { CLIENT_HEADER, MIN_CLIENT } from '@tela/sync'

/** The protocol version this build speaks (ADR 0025); tela-api refuses older ones with 409. */
export const CLIENT_VERSION = MIN_CLIENT

export class SignedOut extends Error {
  override name = 'SignedOut'
}
export class UpgradeRequired extends Error {
  override name = 'UpgradeRequired'
}

export type ApiInit = {
  method?: string
  body?: unknown
  /** Sent as the body verbatim (OPML), instead of JSON. */
  raw?: string
  signal?: AbortSignal
  /** Outlive the page: a push sent as the tab goes away still arrives. */
  keepalive?: boolean
}

export async function api(path: string, init: ApiInit = {}): Promise<Response> {
  const headers: Record<string, string> = { [CLIENT_HEADER]: String(CLIENT_VERSION) }
  if (init.body !== undefined) headers['content-type'] = 'application/json'
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
    if (body?.error === 'upgrade') throw new UpgradeRequired()
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

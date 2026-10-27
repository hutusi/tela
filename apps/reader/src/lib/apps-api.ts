/**
 * The calls the consent page (`/connect`) and Settings → Connected apps make (ADR 0064). Both read
 * live answers, never synced rows: a connection is security state, and an authorization request is
 * checked by tela-api each time the page shows it. Member calls go through `api()`, which names the
 * account the tab holds, so a 401 or another account's cookie reaches the session as it does from
 * any page.
 *
 * Every answer is read field by field before a page shows it: a link the page draws must be
 * https, and the address the browser is sent to must be the app's own.
 */
import {
  APP_SCOPES,
  type AppScope,
  type AuthorizationParams,
  CONNECT_ERRORS,
  type ConnectDecision,
  type ConnectError,
  type Connection,
  type ConnectRequest,
} from '@tela/shared'
import { api, apiJson } from '../store/api'

// ---------------------------------------------------------------------------------------------
// The consent page

/** The authorization request's names (RFC 6749 §4.1.1, RFC 7636): nothing else is passed on. */
export const AUTHORIZATION_PARAMS = [
  'client_id',
  'redirect_uri',
  'response_type',
  'scope',
  'state',
  'code_challenge',
  'code_challenge_method',
] as const satisfies readonly (keyof AuthorizationParams)[]

/**
 * The authorization request in a page's query, as tela-api is asked about it: its own names only,
 * each value as it came (a name given twice stays twice, for tela-api to refuse), and none of what
 * the sign-in sheet adds to an address.
 */
export function requestQuery(search: string): string {
  const from = new URLSearchParams(search)
  const out = new URLSearchParams()
  for (const name of AUTHORIZATION_PARAMS) {
    for (const value of from.getAll(name)) out.append(name, value)
  }
  return out.toString()
}

/** The request's fields, for the decision that answers it; a missing one is empty. */
export function requestParams(search: string): AuthorizationParams {
  const from = new URLSearchParams(search)
  const value = (name: (typeof AUTHORIZATION_PARAMS)[number]) => from.get(name) ?? ''
  const state = from.get('state')
  return {
    client_id: value('client_id'),
    redirect_uri: value('redirect_uri'),
    response_type: value('response_type'),
    scope: value('scope'),
    ...(state === null ? {} : { state }),
    code_challenge: value('code_challenge'),
    code_challenge_method: value('code_challenge_method'),
  }
}

export const isConnectError = (value: unknown): value is ConnectError =>
  CONNECT_ERRORS.some((e) => e === value)

const isScope = (value: unknown): value is AppScope => APP_SCOPES.some((s) => s === value)

/** An https address to link to, or null: anything else is drawn as no link at all. */
export function httpsOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null
  try {
    return new URL(value).protocol === 'https:' ? value : null
  } catch {
    return null
  }
}

/** tela-api's account of a request, or null for an answer of another shape. */
export function readConnectRequest(body: unknown): ConnectRequest | null {
  if (typeof body !== 'object' || body === null) return null
  const { app, scope, email, redirect } = body as Record<string, unknown>
  if (typeof app !== 'object' || app === null) return null
  const a = app as Record<string, unknown>
  if (typeof a.clientId !== 'string' || typeof a.name !== 'string') return null
  if (typeof a.developer !== 'string') return null
  if (a.status !== 'draft' && a.status !== 'approved') return null
  if (!isScope(scope) || typeof email !== 'boolean') return null
  if (typeof redirect !== 'object' || redirect === null) return null
  const r = redirect as Record<string, unknown>
  if ((r.kind !== 'loopback' && r.kind !== 'scheme') || typeof r.target !== 'string') return null
  return {
    app: {
      clientId: a.clientId,
      name: a.name,
      developer: a.developer,
      homepageUrl: httpsOrNull(a.homepageUrl),
      privacyUrl: httpsOrNull(a.privacyUrl),
      status: a.status,
    },
    scope,
    email,
    redirect: { kind: r.kind, target: r.target },
  }
}

/** Why a page cannot go on: tela-api's reason, or `failed` for no answer it could read. */
export type ConnectProblem = ConnectError | 'failed'

const problemOf = (body: unknown): ConnectProblem => {
  const error = (body as { error?: unknown } | null)?.error
  return isConnectError(error) ? error : 'failed'
}

/** `GET /api/v1/connect/request`: the app and what it asks, or why it cannot be shown. */
export async function askConnect(
  search: string,
  signal?: AbortSignal,
): Promise<{ ok: true; request: ConnectRequest } | { ok: false; error: ConnectProblem }> {
  const { status, body } = await apiJson<unknown>(
    `/api/v1/connect/request?${requestQuery(search)}`,
    signal ? { signal } : {},
  )
  if (status !== 200) return { ok: false, error: problemOf(body) }
  const request = readConnectRequest(body)
  return request ? { ok: true, request } : { ok: false, error: 'failed' }
}

/**
 * Whether `redirect` goes where the request said the app listens: the same scheme, and for a
 * loopback address the same host. Anything else (a `javascript:` URL, another site) is never
 * followed, whatever answered.
 */
export function sameApp(redirect: string, redirectUri: string): boolean {
  try {
    const to = new URL(redirect)
    const asked = new URL(redirectUri)
    if (to.protocol !== asked.protocol) return false
    if (to.protocol === 'https:' || to.protocol === 'javascript:' || to.protocol === 'data:') {
      return false
    }
    return to.protocol !== 'http:' || to.hostname === asked.hostname
  } catch {
    return false
  }
}

/**
 * `POST /api/v1/connect/decide`: the member's answer. The reply is the address to send the browser
 * to, with the code (or the refusal) on it; the page follows it with `location.assign`, never a
 * form, which the site's `form-action 'self'` would stop.
 */
export async function decideConnect(
  decision: ConnectDecision,
): Promise<{ ok: true; redirect: string } | { ok: false; error: ConnectProblem }> {
  const { status, body } = await apiJson<unknown>('/api/v1/connect/decide', { body: decision })
  if (status !== 200) return { ok: false, error: problemOf(body) }
  const redirect = (body as { redirect?: unknown } | null)?.redirect
  if (typeof redirect !== 'string' || !sameApp(redirect, decision.redirect_uri)) {
    return { ok: false, error: 'failed' }
  }
  return { ok: true, redirect }
}

// ---------------------------------------------------------------------------------------------
// Settings → Connected apps

const isTime = (value: unknown): value is number => typeof value === 'number' && value >= 0

function readConnection(value: unknown): Connection | null {
  if (typeof value !== 'object' || value === null) return null
  const v = value as Record<string, unknown>
  const app = v.app as Record<string, unknown> | null | undefined
  if (typeof v.id !== 'number' || typeof app !== 'object' || app === null) return null
  if (typeof app.name !== 'string' || typeof app.developer !== 'string') return null
  if (!isScope(v.scope) || typeof v.email !== 'boolean' || !isTime(v.createdAt)) return null
  if (v.lastUsedAt !== null && !isTime(v.lastUsedAt)) return null
  if (typeof v.devices !== 'number') return null
  return {
    id: v.id,
    app: { name: app.name, developer: app.developer, homepageUrl: httpsOrNull(app.homepageUrl) },
    scope: v.scope,
    email: v.email,
    createdAt: v.createdAt,
    lastUsedAt: v.lastUsedAt,
    devices: v.devices,
  }
}

/** `GET /api/v1/connections`'s answer, each connection read on its own; null for another shape. */
export function readConnections(body: unknown): Connection[] | null {
  const list = (body as { connections?: unknown } | null)?.connections
  if (!Array.isArray(list)) return null
  return list.map(readConnection).filter((c): c is Connection => c !== null)
}

export async function listConnections(signal?: AbortSignal): Promise<Connection[] | null> {
  const res = await api('/api/v1/connections', signal ? { signal } : {})
  return res.ok ? readConnections(await res.json().catch(() => null)) : null
}

/** End one connection: the app is refused on every device from its next request. */
export async function disconnect(id: number): Promise<boolean> {
  const res = await api(`/api/v1/connections/${id}`, { method: 'DELETE' })
  return res.ok
}

/**
 * Every call Settings → Invites and Settings → Account make, in one place. Both panels read live
 * RPC answers on purpose, never synced rows: a code is minted and counted against the five by the
 * server the moment it exists, an invite list holds other people's state (who joined), and how a
 * member signs in is security state, read from the session store each time (ADR 0034).
 *
 * Member calls go through `api()`, which names the account the tab holds; its 401 and 409s reach
 * the session as they do from any page. What a page shows comes back as a plain value.
 */
import { groupInviteCode } from '@tela/shared'
import { api, apiJson } from '../store/api'
import { PROVIDERS, type Provider, type SignInError } from './use-sign-in'

// ---------------------------------------------------------------------------------------------
// Invites

/** One of the member's codes that counts toward their five, and who joined with it. */
export type Invite = {
  code: string
  createdAt: number
  joinedAt: number | null
  /** The joiner's handle, never a pending address; null until someone joins. */
  handle: string | null
}

export type Invites = { allowance: number; codes: Invite[] }

export type InviteError = 'allowance_used' | 'rate_limited' | 'failed'

export async function listInvites(signal?: AbortSignal): Promise<Invites | null> {
  const res = await api('/api/v1/invites', signal ? { signal } : {})
  return res.ok ? ((await res.json()) as Invites) : null
}

export async function createInvite(): Promise<
  { ok: true; invite: Invite } | { ok: false; error: InviteError }
> {
  const { status, body } = await apiJson<Invite & { error?: string }>('/api/v1/invites', {
    method: 'POST',
    body: {},
  })
  if (status === 200) return { ok: true, invite: body }
  if (status === 409) return { ok: false, error: 'allowance_used' }
  if (status === 429) return { ok: false, error: 'rate_limited' }
  return { ok: false, error: 'failed' }
}

export async function revokeInvite(code: string): Promise<boolean> {
  const res = await api(`/api/v1/invites/${encodeURIComponent(code)}`, { method: 'DELETE' })
  return res.ok
}

/** The link that opens the join sheet with the code filled in, grouped as it is shown. */
export function inviteLink(code: string, origin = window.location.origin): string {
  return `${origin}/join?code=${groupInviteCode(code)}`
}

// ---------------------------------------------------------------------------------------------
// Account

/** The sheet's providers: Settings links the same two it offers. */
export { PROVIDERS, type Provider }

export type LinkedAccount = { id: string; provider: Provider; since: number }

/** `GET /api/v1/account`, as tela-api answers it (`apps/api/src/routes/account.ts`). */
export type Account = {
  email: string
  /** Whether the member has a password, never the password. */
  hasPassword: boolean
  /** The providers linked, oldest first. */
  linked: LinkedAccount[]
  /** Whether the session is recent enough to add a way in (made within the last day). */
  fresh: boolean
}

const isLinked = (value: unknown): value is LinkedAccount => {
  if (typeof value !== 'object' || value === null) return false
  const { id, provider, since } = value as Record<string, unknown>
  return (
    typeof id === 'string' && PROVIDERS.some((p) => p === provider) && typeof since === 'number'
  )
}

/**
 * The account, or null for an answer of another shape: a field read under the wrong name would
 * otherwise show a member with a password as having none, and offer them the wrong form.
 */
export function readAccount(body: unknown): Account | null {
  if (typeof body !== 'object' || body === null) return null
  const { email, hasPassword, linked, fresh } = body as Record<string, unknown>
  if (typeof email !== 'string' || typeof hasPassword !== 'boolean') return null
  if (typeof fresh !== 'boolean' || !Array.isArray(linked)) return null
  return { email, hasPassword, linked: linked.filter(isLinked), fresh }
}

/**
 * Why a change was refused: `not_fresh` asks the member to confirm it is them first, `rejected`
 * is a 400 (a password of the wrong length, the current one missing or wrong), `rate_limited` a
 * 429, `failed` anything else (a provider Tela does not offer, an account no longer linked).
 */
export type AccountError = 'not_fresh' | 'rejected' | 'rate_limited' | 'failed'

type Outcome<T = object> = ({ ok: true } & T) | { ok: false; error: AccountError }

/**
 * What a change's answer means. tela-api refuses with `{error}`, in lowercase: 403
 * `session_not_fresh`; 400 `new_password_required`, `password_too_short`, `password_too_long`,
 * `current_password_required` or better-auth's `invalid_password`; 404 `unknown_provider` or
 * `not_found`; 429 `rate_limited`.
 */
export function accountOutcome<T extends object>(
  status: number,
  answer: unknown,
): Outcome<{ body: T }> {
  const body = typeof answer === 'object' && answer !== null ? answer : {}
  if (status >= 200 && status < 300) return { ok: true, body: body as T }
  const error = (body as { error?: unknown }).error
  if (status === 403 && error === 'session_not_fresh') return { ok: false, error: 'not_fresh' }
  if (status === 400) return { ok: false, error: 'rejected' }
  if (status === 429) return { ok: false, error: 'rate_limited' }
  return { ok: false, error: 'failed' }
}

async function accountCall<T extends object>(
  path: string,
  body: unknown,
): Promise<Outcome<{ body: T }>> {
  const { status, body: answer } = await apiJson<unknown>(path, { method: 'POST', body })
  return accountOutcome<T>(status, answer)
}

export async function getAccount(signal?: AbortSignal): Promise<Account | null> {
  const res = await api('/api/v1/account', signal ? { signal } : {})
  return res.ok ? readAccount(await res.json().catch(() => null)) : null
}

/** Set a first password (on a fresh session), or change one (`currentPassword` then required). */
export async function setPassword(input: {
  newPassword: string
  currentPassword?: string
}): Promise<Outcome> {
  return accountCall('/api/v1/account/password', input)
}

/** Start linking a provider (on a fresh session): the answer is where to send the browser. */
export async function linkProvider(provider: Provider): Promise<Outcome<{ url: string }>> {
  const answer = await accountCall<{ url?: unknown }>('/api/v1/account/link', { provider })
  if (!answer.ok) return answer
  return typeof answer.body.url === 'string'
    ? { ok: true, url: answer.body.url }
    : { ok: false, error: 'failed' }
}

/** Unlink a provider, by its linked account's id (on a fresh session). */
export async function unlinkProvider(accountId: string): Promise<Outcome> {
  return accountCall('/api/v1/account/unlink', { accountId })
}

/**
 * End every other session of the member's, fresh or not; tela-api says how many it ended.
 * Settings then signs this one out too, which is what "everywhere" promises.
 */
export async function signOutEverywhere(): Promise<Outcome> {
  return accountCall('/api/v1/account/sign-out-everywhere', {})
}

/**
 * Whether a page's query is a link's return from Google or GitHub: tela-api fixes where that is,
 * `/settings?linked=<provider>`, or `/settings?error=<code>` when it did not work, and it is the
 * Account section's to show.
 */
export function linkingReturn(search: string): boolean {
  const params = new URLSearchParams(search)
  return params.has('linked') || params.has('error')
}

/** Which providers tela-api has secrets for: a 404 (or anything unreadable) means none. */
export async function configuredProviders(): Promise<Record<Provider, boolean>> {
  try {
    const res = await fetch('/api/v1/public/auth', { credentials: 'same-origin' })
    if (!res.ok) return { google: false, github: false }
    const body = (await res.json()) as Partial<Record<Provider, unknown>>
    return { google: body.google === true, github: body.github === true }
  } catch {
    return { google: false, github: false }
  }
}

/**
 * Confirming it is them, without leaving Settings: a sign-in code mailed to the member's own
 * address, then a sign-in with it, which starts a fresh session for the same account. The login
 * page would not do: it sends a member straight on to `next`.
 */
const authPost = (path: string, body: unknown) =>
  fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify(body),
  })

/** The sheet's words for the same refusals (`door.errors.*`): a 429 is never a wrong code. */
export type ConfirmError = Extract<SignInError, 'rate_limited' | 'bad_code' | 'send_failed'>

export async function sendConfirmCode(email: string): Promise<ConfirmError | null> {
  const res = await authPost('/api/auth/email-otp/send-verification-otp', {
    email,
    type: 'sign-in',
  })
  if (res.ok) return null
  return res.status === 429 ? 'rate_limited' : 'send_failed'
}

export async function confirmWithCode(email: string, otp: string): Promise<ConfirmError | null> {
  const res = await authPost('/api/auth/sign-in/email-otp', { email, otp })
  if (res.ok) return null
  return res.status === 429 ? 'rate_limited' : 'bad_code'
}

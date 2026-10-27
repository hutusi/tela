/**
 * Approved apps in tests (ADR 0064): an app registered straight into the database (the console's
 * Apps area is its own slice), a member approving it on the consent page's route, and the app on
 * the other side, speaking OAuth to `/gateway` as tela-gateway forwards it.
 */
import { first, newClientId, pkceS256, randomSecret } from '@tela/data'
import type { AppScope, AppStatus } from '@tela/shared'
import { sql } from 'drizzle-orm'
import { API_ORIGIN, type SignedIn, type TestApi } from './helpers'

/** The loopback redirect every test app registers, matched on any port. */
export const REDIRECT = 'http://127.0.0.1/callback'
/** Where a test app listens this time. */
export const LISTENING = 'http://127.0.0.1:53682/callback'

export type TestApp = { id: number; clientId: string }

let made = 0

/** An app as the operator would register it: approved, read and write, with a loopback redirect. */
export async function registerApp(
  api: TestApi,
  input: {
    status?: AppStatus
    maxScope?: AppScope
    allowEmail?: boolean
    ownerUserId?: string | null
    redirectUris?: string[]
    grantTypes?: string[]
    perMemberPerMin?: number | null
    perAppPerMin?: number | null
    maxConnections?: number | null
  } = {},
): Promise<TestApp> {
  const clientId = newClientId()
  const now = api.clock.now()
  const row = await first<{ id: number }>(
    api.db,
    sql`insert into apps (client_id, name, developer, contact_email, homepage_url, privacy_url,
        redirect_uris, grant_types, max_scope, allow_email, status, owner_user_id,
        per_member_per_min, per_app_per_min, max_connections, created_at, updated_at)
      values (${clientId}, ${`App ${++made}`}, 'Dev Ltd', 'dev@app.example',
        'https://app.example', 'https://app.example/privacy',
        ${JSON.stringify(input.redirectUris ?? [REDIRECT])}, ${JSON.stringify(input.grantTypes ?? ['code'])},
        ${input.maxScope ?? 'write'}, ${input.allowEmail ? 1 : 0}, ${input.status ?? 'approved'},
        ${input.ownerUserId ?? null}, ${input.perMemberPerMin ?? null}, ${input.perAppPerMin ?? null},
        ${input.maxConnections ?? null}, ${now}, ${now})
      returning id`,
  )
  if (!row) throw new Error('app not registered')
  return { id: row.id, clientId }
}

/** A PKCE pair (RFC 7636): the verifier the app keeps, and the challenge it sends. */
export async function pkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = randomSecret(32)
  return { verifier, challenge: await pkceS256(verifier) }
}

/** An authorization request's parameters, as the consent page passes them through. */
export function authorizationParams(
  app: TestApp,
  challenge: string,
  overrides: Record<string, string | undefined> = {},
): Record<string, string> {
  const params: Record<string, string | undefined> = {
    client_id: app.clientId,
    redirect_uri: LISTENING,
    response_type: 'code',
    scope: 'write',
    state: 'xyz',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    ...overrides,
  }
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(params)) if (value !== undefined) out[name] = value
  return out
}

/** The consent page's first question: the request, checked. */
export function askConsent(api: TestApi, who: SignedIn, params: Record<string, string>) {
  return api.request(`/api/v1/connect/request?${new URLSearchParams(params)}`, { as: who })
}

/** The member's answer on the consent page. */
export function decide(
  api: TestApi,
  who: SignedIn,
  params: Record<string, string>,
  answer: { decision?: string; scope_granted?: string; email_granted?: boolean } = {},
) {
  return api.request('/api/v1/connect/decide', {
    as: who,
    body: {
      ...params,
      decision: answer.decision ?? 'approve',
      scope_granted: answer.scope_granted ?? params.scope?.split(' ').find((w) => w !== 'email'),
      email_granted: answer.email_granted ?? false,
    },
  })
}

/** Approve an app for a member, and the code its redirect carries. */
export async function approve(
  api: TestApi,
  who: SignedIn,
  app: TestApp,
  options: {
    scope?: string
    granted?: AppScope
    email?: boolean
    redirectUri?: string
  } = {},
): Promise<{ code: string; verifier: string; redirectUri: string }> {
  const { verifier, challenge } = await pkce()
  const redirectUri = options.redirectUri ?? LISTENING
  const params = authorizationParams(app, challenge, {
    scope: options.scope ?? 'write',
    redirect_uri: redirectUri,
  })
  const res = await decide(api, who, params, {
    ...(options.granted ? { scope_granted: options.granted } : {}),
    ...(options.email === undefined ? {} : { email_granted: options.email }),
  })
  if (res.status !== 200) throw new Error(`approve failed: ${res.status} ${await res.text()}`)
  const { redirect } = (await res.json()) as { redirect: string }
  const code = new URL(redirect).searchParams.get('code')
  if (!code) throw new Error(`no code in ${redirect}`)
  return { code, verifier, redirectUri }
}

/** A request to the app surface, as tela-gateway forwards it: no cookie unless a test adds one. */
export function gateway(
  api: TestApi,
  path: string,
  init: {
    method?: string
    token?: string
    headers?: Record<string, string>
    form?: Record<string, string>
    body?: string
  } = {},
) {
  const headers: Record<string, string> = { ...init.headers }
  if (init.token) headers.authorization = `Bearer ${init.token}`
  let body: string | undefined = init.body
  if (init.form) {
    headers['content-type'] = 'application/x-www-form-urlencoded'
    body = new URLSearchParams(init.form).toString()
  }
  return api.app.request(`${API_ORIGIN}/gateway${path}`, {
    method: init.method ?? (body === undefined ? 'GET' : 'POST'),
    headers,
    ...(body === undefined ? {} : { body }),
  })
}

export type TokenAnswer = {
  access_token: string
  token_type: string
  expires_in: number
  refresh_token: string
  scope: string
}

/** `POST /oauth/token`, form-encoded, from an IP of the test's choosing. */
export function token(api: TestApi, form: Record<string, string>, ip = '203.0.113.7') {
  return gateway(api, '/oauth/token', { form, headers: { 'cf-connecting-ip': ip } })
}

/** Exchange a code as the app would. */
export function exchange(
  api: TestApi,
  app: TestApp,
  grant: { code: string; verifier: string; redirectUri: string },
) {
  return token(api, {
    grant_type: 'authorization_code',
    code: grant.code,
    redirect_uri: grant.redirectUri,
    client_id: app.clientId,
    code_verifier: grant.verifier,
  })
}

/** Swap a refresh token as the app would. */
export function refresh(api: TestApi, app: TestApp, refreshToken: string) {
  return token(api, {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: app.clientId,
  })
}

/** Connect an app for a member, end to end: consent, code, tokens. */
export async function connect(
  api: TestApi,
  who: SignedIn,
  app: TestApp,
  options: Parameters<typeof approve>[3] = {},
): Promise<TokenAnswer> {
  const res = await exchange(api, app, await approve(api, who, app, options))
  if (res.status !== 200) throw new Error(`exchange failed: ${res.status} ${await res.text()}`)
  return (await res.json()) as TokenAnswer
}

/** `GET /v1/me` with an access token: the status, which is all most tests ask. */
export async function meStatus(api: TestApi, accessToken: string): Promise<number> {
  return (await gateway(api, '/v1/me', { token: accessToken })).status
}

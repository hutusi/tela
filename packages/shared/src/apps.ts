/**
 * Approved apps (ADRs 0064, 0065): third-party clients a member connects in the browser, which then
 * act for them through `api.telaread.com` with a token, never a cookie. Constants only, shared by
 * tela-api, the gateway, the admin console and the reader.
 */

/** Where an app stands. A draft connects only for its owner; a suspended app for no one. */
export const APP_STATUSES = ['draft', 'approved', 'suspended'] as const
export type AppStatus = (typeof APP_STATUSES)[number]

/** What a member grants: `read`, or `write`, which includes it. */
export const APP_SCOPES = ['read', 'write'] as const
export type AppScope = (typeof APP_SCOPES)[number]

/** The lower of two scopes: what a token may do once the app's own ceiling is applied. */
export function lowerScope(a: AppScope, b: AppScope): AppScope {
  return a === 'write' && b === 'write' ? 'write' : 'read'
}

/** The grants an app may use. Only `code` is built; `device` is reserved (ADR 0064). */
export const APP_GRANT_TYPES = ['code', 'device'] as const
export type AppGrantType = (typeof APP_GRANT_TYPES)[number]

/** How a token was made. Only `oauth` is built; `personal` is reserved for app tokens. */
export const APP_TOKEN_KINDS = ['oauth', 'personal'] as const
export type AppTokenKind = (typeof APP_TOKEN_KINDS)[number]

/** Why a connection or one device's tokens ended. */
export const APP_END_REASONS = [
  // The member, in Settings.
  'disconnected',
  // Everywhere Tela ends a member's other sessions (`endConnectionsSql`).
  'password',
  'link',
  'signOutEverywhere',
  'operatorSignOut',
  'suspended',
  'closed',
  // The operator, for one app.
  'appEnded',
  // A refresh token or code came back after it was spent.
  'reuse',
  // The app revoked it (RFC 7009), or the member connected the same app again on that device.
  'revoked',
  'replaced',
] as const
export type AppEndReason = (typeof APP_END_REASONS)[number]

/** Token prefixes: they tell a Tela token from anything else at a glance, and to secret scanners. */
export const ACCESS_TOKEN_PREFIX = 'tela_at_'
export const REFRESH_TOKEN_PREFIX = 'tela_rt_'
export const CLIENT_ID_PREFIX = 'tela_app_'

/** An access token lives an hour. */
export const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000
/** A refresh token ends after 90 days unused; each use moves the end. */
export const REFRESH_IDLE_MS = 90 * 24 * 60 * 60 * 1000
/** A spent refresh token may be swapped once more this long after, while its replacement is unused. */
export const REFRESH_GRACE_MS = 2 * 60 * 1000
/** An authorization code lives two minutes. */
export const AUTH_CODE_TTL_MS = 2 * 60 * 1000

/** The longest name, developer and URL an app may have. */
export const APP_NAME_MAX = 80
export const APP_TEXT_MAX = 300
export const APP_URL_MAX = 500
/** Redirect URIs one app may register. */
export const APP_REDIRECTS_MAX = 10

/** Requests an app may make per member, and in all, per minute, unless the operator sets others. */
export const APP_DEFAULT_PER_MEMBER_PER_MIN = 120
export const APP_DEFAULT_PER_APP_PER_MIN = 6000

/**
 * The external API's versions (ADR 0065). `preview` may still break, with 14 days' notice to the
 * apps' developers; `stable` changes only by addition; `deprecated` carries a sunset date.
 */
export const API_VERSION_STATUSES = ['preview', 'stable', 'deprecated'] as const
export type ApiVersionStatus = (typeof API_VERSION_STATUSES)[number]

export type ApiVersion = {
  version: number
  status: ApiVersionStatus
  /** When it stops answering, epoch ms; null while none is set. */
  sunsetAt: number | null
}

export const API_VERSIONS: readonly ApiVersion[] = [
  { version: 1, status: 'preview', sunsetAt: null },
]
export const API_CURRENT_VERSION = 1
/** The response header every API answer carries: `apiVersionOf` its path. */
export const API_VERSION_HEADER = 'tela-api-version'

/**
 * The version an answer on the API host belongs to, from its path: `/v<n>/…` is version n when
 * Tela has one, so a v1 answer still says 1 once a v2 is current; anything outside a version
 * (`/meta`, OAuth's endpoints, a 404) says the current one.
 */
export function apiVersionOf(
  path: string,
  versions: readonly ApiVersion[] = API_VERSIONS,
  current: number = API_CURRENT_VERSION,
): number {
  const n = Number(/^\/v(\d+)(?:\/|$)/.exec(path)?.[1])
  return versions.some((v) => v.version === n) ? n : current
}

/**
 * The consent page's questions to tela-api (`/connect`, ADR 0064). Both are internal member routes
 * under `/api/v1`, with the web's checks; the page passes the authorization request's query
 * through as it came (RFC 6749 §4.1.1 names).
 */
export type AuthorizationParams = {
  client_id: string
  redirect_uri: string
  response_type: string
  /** Space-separated: `read`, or `write`, and `email` if the app asks to see it. */
  scope: string
  state?: string
  code_challenge: string
  code_challenge_method: string
}

/** `GET /api/v1/connect/request?<AuthorizationParams>`: the app and what it asks, once checked. */
export type ConnectRequest = {
  app: {
    clientId: string
    name: string
    developer: string
    homepageUrl: string | null
    privacyUrl: string | null
    /** A draft is shown only to its owner, and says so. */
    status: Extract<AppStatus, 'draft' | 'approved'>
  }
  /** What it asks for; the member may lower `write` to `read`. */
  scope: AppScope
  /** It asks to see the member's email, and the operator lets it. */
  email: boolean
  /** Where the answer goes: a port on this computer, or the app's own scheme. */
  redirect: { kind: 'loopback' | 'scheme'; target: string }
}

/**
 * Why a request cannot be shown. The page shows these itself and never redirects: a bad client or
 * redirect could send the member anywhere.
 */
export const CONNECT_ERRORS = [
  'invalid_client',
  'invalid_redirect',
  'invalid_request',
  'unsupported_response_type',
  'invalid_scope',
  'app_unavailable',
  'max_connections',
] as const
export type ConnectError = (typeof CONNECT_ERRORS)[number]

/**
 * `POST /api/v1/connect/decide`: the member's answer, with the request it answers (checked again).
 * The reply is `{ redirect }`, the URI to send the browser to: with `code` and `state` on approval,
 * `error=access_denied` on decline, and `iss` either way (RFC 9207).
 */
export type ConnectDecision = AuthorizationParams & {
  decision: 'approve' | 'decline'
  /** At most what was asked. */
  scope_granted: AppScope
  email_granted: boolean
}

/** `GET /api/v1/connections`: the member's live connections, for Settings → Connected apps. */
export type Connection = {
  id: number
  app: { name: string; developer: string; homepageUrl: string | null }
  scope: AppScope
  email: boolean
  createdAt: number
  /** To the hour; Settings shows the day. Null until first used. */
  lastUsedAt: number | null
  /** Devices with live tokens under it. */
  devices: number
}

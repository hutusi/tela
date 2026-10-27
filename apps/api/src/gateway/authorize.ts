/**
 * The authorization request's rules (ADR 0064, RFC 8252 for native apps), pure, for the consent
 * page's checks in `routes/connect.ts`: which redirect an app may be sent to, what a scope string
 * asks for, and what a PKCE challenge and verifier must look like.
 */
import { APP_URL_MAX, type AppScope, type ConnectRequest } from '@tela/shared'

/** The loopback hosts a native app may listen on (RFC 8252 §7.3). `localhost` is not one. */
const LOOPBACK_HOSTS = ['127.0.0.1', '[::1]'] as const

/**
 * Schemes no redirect may use, registered or not: the web's own (an app returns to a port on this
 * computer or to its own scheme, never to a site), and those a browser would run or read locally.
 */
const REFUSED_SCHEMES: ReadonlySet<string> = new Set([
  'http',
  'https',
  'ws',
  'wss',
  'ftp',
  'javascript',
  'vbscript',
  'data',
  'blob',
  'file',
  'about',
  'filesystem',
  'mailto',
  'tel',
  'sms',
  'intent',
  'chrome',
  'view-source',
])

const SCHEME = /^[a-z][a-z0-9+.-]*$/

function parse(uri: string): URL | null {
  try {
    return new URL(uri)
  } catch {
    return null
  }
}

/** The loopback host a URI names, as written, or null for any other. */
function loopbackHost(uri: string, url: URL): string | null {
  if (url.protocol !== 'http:' || url.username || url.password) return null
  // As written, not only as parsed: `http://127.1/` parses to 127.0.0.1, and an answer goes back to
  // what the app sent.
  for (const host of LOOPBACK_HOSTS) {
    const prefix = `http://${host}`
    const next = uri.charAt(prefix.length)
    if (url.hostname === host && uri.startsWith(prefix) && ['', ':', '/', '?'].includes(next)) {
      return host
    }
  }
  return null
}

/**
 * Where a request may be answered, or null for nowhere: the consent page then shows an error and
 * never redirects (RFC 6749 §4.1.2.1).
 *
 * - A loopback redirect (`http://127.0.0.1` or `http://[::1]`) matches a registered one on the same
 *   host with the same path and query, on any port (RFC 8252 §7.3).
 * - A custom scheme matches a registered URI exactly (§7.1).
 * - Nothing else does: no `localhost` (§8.3), no web address, no fragment, no credentials.
 */
export function matchRedirect(
  registered: readonly string[],
  asked: string,
): ConnectRequest['redirect'] | null {
  if (asked.length === 0 || asked.length > APP_URL_MAX || asked.includes('#')) return null
  const url = parse(asked)
  if (!url) return null
  const host = loopbackHost(asked, url)
  if (host) {
    const found = registered.some((r) => {
      const known = parse(r)
      return (
        known !== null &&
        loopbackHost(r, known) === host &&
        known.pathname === url.pathname &&
        known.search === url.search
      )
    })
    return found ? { kind: 'loopback', target: `${host}:${url.port || '80'}` } : null
  }
  const scheme = url.protocol.slice(0, -1)
  if (!SCHEME.test(scheme) || REFUSED_SCHEMES.has(scheme)) return null
  if (url.username || url.password) return null
  return registered.includes(asked) ? { kind: 'scheme', target: scheme } : null
}

/**
 * What a scope string asks for: `read` or `write` (both is `write`), and `email` beside either.
 * Null for anything else in it, or neither level (RFC 6749 §3.3 says the server may default; Tela
 * asks an app to say which).
 */
export function parseScope(scope: string): { scope: AppScope; email: boolean } | null {
  const words = scope.split(' ').filter((w) => w.length > 0)
  if (words.some((w) => w !== 'read' && w !== 'write' && w !== 'email')) return null
  const level: AppScope | null = words.includes('write')
    ? 'write'
    : words.includes('read')
      ? 'read'
      : null
  return level ? { scope: level, email: words.includes('email') } : null
}

/** The scope a token response names (RFC 6749 §5.1): its level, and `email` when granted. */
export const scopeText = (scope: AppScope, email: boolean) => (email ? `${scope} email` : scope)

/** An S256 challenge: the base64url of 32 bytes, unpadded (RFC 7636 §4.2). */
export const isChallenge = (value: string) => /^[A-Za-z0-9_-]{43}$/.test(value)

/** A code verifier: 43 to 128 unreserved characters (RFC 7636 §4.1). */
export const isVerifier = (value: string) => /^[A-Za-z0-9\-._~]{43,128}$/.test(value)

/** The most a `state` may hold: an app's own value, echoed back, not a store. */
export const STATE_MAX = 1024

/**
 * The redirect URI with the answer's parameters added (RFC 6749 §4.1.2, RFC 9207's `iss`), its own
 * query kept. Only ever called on a URI `matchRedirect` accepted.
 */
export function answerAt(redirectUri: string, params: Record<string, string | undefined>): string {
  const url = new URL(redirectUri)
  for (const [name, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(name, value)
  }
  return url.toString()
}

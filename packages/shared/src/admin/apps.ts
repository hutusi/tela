/**
 * The console's Apps area (ADRs 0039, 0064): the apps the operator registers, approves and cuts
 * off, and the rule every registration is held to. The rule is here, beside the types, so the
 * console's form refuses what tela-api would, field by field, before anything is sent.
 */

import {
  APP_NAME_MAX,
  APP_REDIRECTS_MAX,
  APP_SCOPES,
  APP_TEXT_MAX,
  APP_URL_MAX,
  type AppScope,
  type AppStatus,
} from '../apps'
import { isValidHandle } from '../handles'
import type { AdminHistoryEntry, AdminPerson, AdminRowBase } from './common'

/** The most requests a minute, or connections, an operator may set as an app's limit. */
export const APP_LIMIT_MAX = 1_000_000

/**
 * What the operator registers an app with, and edits (`app.create`, `app.edit`). The limits are
 * null for the default (`APP_DEFAULT_PER_*`, or no cap on connections) and 0 for none at all.
 */
export type AdminAppSettings = {
  name: string
  developer: string
  /** Where the operator writes to the developer: approval, deprecations, a cut-off. */
  contactEmail: string
  homepageUrl: string | null
  privacyUrl: string | null
  /** Exact redirect URIs: loopback (any port matches) or a reverse-DNS scheme (RFC 8252). */
  redirectUris: string[]
  /** The most a member may grant it. */
  maxScope: AppScope
  /** Whether it may ask to see the member's email address. */
  allowEmail: boolean
  /** The handle of the one account a draft connects for (its developer's, to test); or none. */
  owner: string | null
  perMemberPerMin: number | null
  perAppPerMin: number | null
  maxConnections: number | null
}

export type AppField = keyof AdminAppSettings

export type AdminAppRow = AdminRowBase &
  Omit<AdminAppSettings, 'owner'> & {
    appId: number
    /** Its public `client_id`, `tela_app_…`. */
    clientId: string
    status: AppStatus
    owner: AdminPerson | null
    createdAt: number
    approvedAt: number | null
    suspendedAt: number | null
    /** Members connected to it now. */
    connections: number
    /** When it last acted for anyone, to the hour; null if never. */
    lastUsedAt: number | null
  }

export type AdminAppDetail = { app: AdminAppRow; history: AdminHistoryEntry[] }

/** No control characters, and nothing that is only spaces. */
const PLAIN = /^[^\p{Cc}]*$/u
export const APP_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const EMAIL = APP_EMAIL
/** A loopback redirect: `127.0.0.1` or `[::1]`, over http, any port. Never `localhost`. */
const LOOPBACK = /^http:\/\/(?:127\.0\.0\.1|\[::1\])(?::[1-9]\d{0,4})?\/[^\s#]*$/
/**
 * A private-use scheme, as RFC 8252 §7.1 has it: a reverse domain name the developer controls
 * (`com.example.app`, two labels at least), then `:/` and a path. Lowercase, as a URL reads it.
 */
const SCHEME = /^[a-z][a-z0-9-]*(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+:\/(?!\/)[^\s#]*$/

/**
 * Which kind of redirect a URI is, or null for one no app may register: plain http anywhere but
 * a loopback address, `localhost`, https, a fragment, or a URI not written as a browser reads it
 * (`http://127.1/` is 127.0.0.1 to a browser, and would match nothing registered).
 */
export function redirectKind(uri: string): 'loopback' | 'scheme' | null {
  if (uri.length > APP_URL_MAX) return null
  const kind = LOOPBACK.test(uri) ? 'loopback' : SCHEME.test(uri) ? 'scheme' : null
  if (kind === null) return null
  try {
    return new URL(uri).href === uri ? kind : null
  } catch {
    return null
  }
}

/** An https address to link to, at most `APP_URL_MAX` long, or null for none (empty). */
export function httpsUrl(value: unknown): string | null | undefined {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string') return undefined
  const url = value.trim()
  if (url === '') return null
  if (url.length > APP_URL_MAX || /\s/.test(url)) return undefined
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return undefined
    return url
  } catch {
    return undefined
  }
}

/** 1 to `APP_REDIRECTS_MAX` distinct redirect URIs, each one an app may register. */
export function isRedirectList(uris: unknown): uris is string[] {
  return (
    Array.isArray(uris) &&
    uris.length > 0 &&
    uris.length <= APP_REDIRECTS_MAX &&
    uris.every((uri) => typeof uri === 'string' && redirectKind(uri) !== null) &&
    new Set(uris).size === uris.length
  )
}

/** A limit: null for the default, else a whole number from 0. */
function limit(value: unknown): number | null | undefined {
  if (value === null || value === undefined || value === '') return null
  if (typeof value !== 'number' || !Number.isInteger(value)) return undefined
  return value >= 0 && value <= APP_LIMIT_MAX ? value : undefined
}

/** Trimmed text of 1 to `max` characters with no control characters, or undefined. */
export function appText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length >= 1 && trimmed.length <= max && PLAIN.test(trimmed) ? trimmed : undefined
}

/**
 * An app's settings as the console sends them, checked and tidied (trimmed, a handle without its
 * `@`), or the first field that is wrong. tela-api runs the same check on every `app.create` and
 * `app.edit`.
 */
export function parseAppSettings(
  value: unknown,
): { ok: true; value: AdminAppSettings } | { ok: false; field: AppField } {
  if (typeof value !== 'object' || value === null) return { ok: false, field: 'name' }
  const v = value as Record<string, unknown>
  const name = appText(v.name, APP_NAME_MAX)
  if (name === undefined) return { ok: false, field: 'name' }
  const developer = appText(v.developer, APP_TEXT_MAX)
  if (developer === undefined) return { ok: false, field: 'developer' }
  const contactEmail = appText(v.contactEmail, APP_TEXT_MAX)
  if (contactEmail === undefined || !EMAIL.test(contactEmail)) {
    return { ok: false, field: 'contactEmail' }
  }
  const homepageUrl = httpsUrl(v.homepageUrl)
  if (homepageUrl === undefined) return { ok: false, field: 'homepageUrl' }
  const privacyUrl = httpsUrl(v.privacyUrl)
  if (privacyUrl === undefined) return { ok: false, field: 'privacyUrl' }
  const uris = v.redirectUris
  if (!isRedirectList(uris)) return { ok: false, field: 'redirectUris' }
  if (!APP_SCOPES.some((s) => s === v.maxScope)) return { ok: false, field: 'maxScope' }
  if (typeof v.allowEmail !== 'boolean') return { ok: false, field: 'allowEmail' }
  let owner: string | null = null
  if (v.owner !== null && v.owner !== undefined && v.owner !== '') {
    const handle = typeof v.owner === 'string' ? v.owner.trim().replace(/^@/, '').toLowerCase() : ''
    if (!isValidHandle(handle)) return { ok: false, field: 'owner' }
    owner = handle
  }
  const perMemberPerMin = limit(v.perMemberPerMin)
  if (perMemberPerMin === undefined) return { ok: false, field: 'perMemberPerMin' }
  const perAppPerMin = limit(v.perAppPerMin)
  if (perAppPerMin === undefined) return { ok: false, field: 'perAppPerMin' }
  const maxConnections = limit(v.maxConnections)
  if (maxConnections === undefined) return { ok: false, field: 'maxConnections' }
  return {
    ok: true,
    value: {
      name,
      developer,
      contactEmail,
      homepageUrl,
      privacyUrl,
      redirectUris: uris as string[],
      maxScope: v.maxScope as AppScope,
      allowEmail: v.allowEmail,
      owner,
      perMemberPerMin,
      perAppPerMin,
      maxConnections,
    },
  }
}

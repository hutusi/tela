/**
 * The v1 API's pure parts with no zod (ADR 0065), so an edge can import them: the error codes, the
 * row types sync speaks, and the opaque cursor. The mappers from the shared functions' results to
 * each route's format join them in their own slice.
 */
import { READING_LANGUAGES, type ReadingLanguage } from '@tela/shared'

/**
 * Every `error` an API answer may carry. Open: an app treats a code it does not know by its HTTP
 * status (a 4xx it cannot fix, a 429 or 503 to retry after `Retry-After`).
 */
export const API_ERRORS = [
  // 400
  'invalid_request',
  'invalid_cursor',
  // 401: the token is missing, unknown, expired or ended (RFC 6750).
  'invalid_token',
  // 403: the token's scope does not cover this (RFC 6750).
  'insufficient_scope',
  // 404, 413
  'not_found',
  'too_large',
  // 409
  'subscription_limit',
  // 429: retry after `Retry-After`.
  'rate_limited',
  'feed_limit',
  'post_limit',
  // 503: retry after `Retry-After`.
  'apps_paused',
  'unavailable',
] as const
export type ApiError = (typeof API_ERRORS)[number]

/**
 * The row types v1 sync speaks, in the order a snapshot lists them. Adding one is additive: an app
 * asks for it by name, and a cursor that did not cover it gets `reset`.
 */
export const V1_ROW_TYPES = [
  'profile',
  'prefs',
  'subscriptions',
  'feeds',
  'sites',
  'articles',
  'titles',
  'states',
  'recommendations',
  'highlights',
  'translations',
  'folders',
  'feedFolders',
  'follows',
] as const
export type V1RowType = (typeof V1_ROW_TYPES)[number]

/** What a v1 cursor holds. Opaque to apps: they send back what they were given. */
export type V1Cursor = {
  /** The sync sequence the app has every row up to. */
  seq: number
  /** The one reading language its titles and translations are in. */
  lang: ReadingLanguage
  /** The row types it holds whole up to `seq`. */
  types: V1RowType[]
}

const CURSOR_VERSION = 1

function base64url(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

function unbase64url(text: string): string | null {
  try {
    const binary = atob(text.replaceAll('-', '+').replaceAll('_', '/'))
    return new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)))
  } catch {
    return null
  }
}

export function encodeCursor(cursor: V1Cursor): string {
  return base64url(
    JSON.stringify({ v: CURSOR_VERSION, s: cursor.seq, l: cursor.lang, t: cursor.types }),
  )
}

/** The cursor an app sent, or null when it is not one Tela made (the app starts with a snapshot). */
export function decodeCursor(text: string): V1Cursor | null {
  if (text.length === 0 || text.length > 512) return null
  const json = unbase64url(text)
  if (json === null) return null
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null) return null
  const { v, s, l, t } = raw as Record<string, unknown>
  if (v !== CURSOR_VERSION) return null
  if (typeof s !== 'number' || !Number.isSafeInteger(s) || s < 0) return null
  if (typeof l !== 'string' || !(READING_LANGUAGES as readonly string[]).includes(l)) return null
  if (!Array.isArray(t) || !t.every((x) => (V1_ROW_TYPES as readonly unknown[]).includes(x)))
    return null
  return { seq: s, lang: l as ReadingLanguage, types: [...new Set(t as V1RowType[])] }
}

/**
 * Whether a pull with this cursor must start over: the app asked for another language, or for a
 * row type the cursor does not hold whole.
 */
export function cursorNeedsReset(
  cursor: V1Cursor | null,
  lang: ReadingLanguage,
  types: readonly V1RowType[],
): boolean {
  if (cursor === null || cursor.seq === 0) return true
  if (cursor.lang !== lang) return true
  return types.some((type) => !cursor.types.includes(type))
}

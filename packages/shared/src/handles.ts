/**
 * A member's handle, their address on Tela (`/@handle`): unique, and chosen in Settings. tela-api
 * refuses what these rules refuse; the reader reads them to say so before it asks.
 */
export const HANDLE = /^[a-z0-9_]{3,30}$/

/** Handles are URLs (`/@handle`), so the app's own paths are taken. */
export const RESERVED_HANDLES: ReadonlySet<string> = new Set([
  'admin',
  'tela',
  'settings',
  'dashboard',
  'login',
  'logout',
  'api',
  'reading',
  'discover',
  'add',
  'claim',
  'sites',
  's',
  'o',
  'img',
  'avatar',
  'u',
  'auth',
  'about',
  'help',
  'support',
  'me',
  'profile',
  'search',
  'following',
  'writers',
  'join',
  'invites',
  'privacy',
  'terms',
])

export const isValidHandle = (h: string) => HANDLE.test(h) && !RESERVED_HANDLES.has(h)

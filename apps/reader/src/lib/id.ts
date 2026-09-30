/**
 * A random id: a UUID where the browser has `crypto.randomUUID`, which is only in a secure
 * context (https, or localhost), and otherwise the time and a random tail. The dev server opened
 * from a phone over the LAN is plain http.
 */
export const newId = (): string =>
  typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`

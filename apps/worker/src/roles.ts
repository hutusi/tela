/**
 * Worker roles. One process runs any subset; WORKER_ROLES=fetch,translate picks them.
 * `relay` is special: it only serves the HTTP fetch relay and never touches the DB.
 */
export const WORKER_ROLES = [
  'scheduler',
  'fetch',
  'extract',
  'translate',
  'assets',
  'claim',
  'relay',
] as const
export type WorkerRole = (typeof WORKER_ROLES)[number]

export function isWorkerRole(value: string): value is WorkerRole {
  return (WORKER_ROLES as readonly string[]).includes(value)
}

export function parseRoles(raw: string | undefined): WorkerRole[] {
  const parts = (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  if (parts.length === 0) {
    return WORKER_ROLES.filter((r) => r !== 'relay')
  }
  const bad = parts.filter((p) => !isWorkerRole(p))
  if (bad.length > 0) {
    throw new Error(`Unknown WORKER_ROLES: ${bad.join(', ')}. Valid: ${WORKER_ROLES.join(', ')}`)
  }
  return [...new Set(parts as WorkerRole[])]
}

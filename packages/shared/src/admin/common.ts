/**
 * The admin console's contract (ADR 0039): what tela-api's `/api/v1/admin/*` answers and what the
 * reader's admin chunk asks. Types and `as const` lists only, so nothing here reaches a bundle that
 * does not import it. Times are epoch milliseconds. The server sends data and codes, never labels:
 * the console translates every word it shows.
 */

/** The console's areas, in the order the sidebar lists them. */
export const ADMIN_AREAS = [
  'overview',
  'claims',
  'sites',
  'feeds',
  'discover',
  'people',
  'invites',
  'translation',
  'system',
] as const
export type AdminArea = (typeof ADMIN_AREAS)[number]

/** Each ledger's filters; the first is where the area opens. */
export const ADMIN_FILTERS = {
  claims: ['review', 'checking', 'verified'],
  sites: ['discover', 'private', 'attention', 'hidden'],
  feeds: ['failing', 'timeout', 'dead', 'paused', 'merged', 'fetching'],
  discover: ['featured', 'listed', 'candidates', 'hidden'],
  people: ['admins', 'members'],
  invites: ['codes', 'waiting', 'revoked'],
  translation: ['blogs', 'jobs', 'models'],
  system: ['dead', 'retrying', 'resolved'],
} as const satisfies Record<Exclude<AdminArea, 'overview'>, readonly string[]>
export type LedgerArea = keyof typeof ADMIN_FILTERS
export type AdminFilter<A extends LedgerArea = LedgerArea> = (typeof ADMIN_FILTERS)[A][number]

export function isLedgerArea(value: unknown): value is LedgerArea {
  return typeof value === 'string' && value in ADMIN_FILTERS
}

export function isAdminFilter<A extends LedgerArea>(
  area: A,
  value: unknown,
): value is AdminFilter<A> {
  return typeof value === 'string' && (ADMIN_FILTERS[area] as readonly string[]).includes(value)
}

/** What a status dot says: the colour of the state, never its words. */
export const ADMIN_TONES = ['ok', 'warn', 'bad', 'info', 'neutral'] as const
export type AdminTone = (typeof ADMIN_TONES)[number]

/**
 * Everything an operator can do. The server lists, per row, which of these apply to it now; the
 * console maps each to its label, its look and its key. Grouped by what they act on: the id of a
 * request names a site, claim, feed, dead letter, lease (`kind:key`), member, code or hold.
 */
export const ADMIN_ACTIONS = [
  'site.feature',
  'site.list',
  'site.hide',
  'site.restore',
  'site.topics',
  'site.translationOff',
  'site.translationOn',
  'site.fetchAll',
  'claim.recheck',
  'claim.vouch',
  'claim.reject',
  'claim.dismiss',
  'claim.remove',
  'feed.fetch',
  'feed.pause',
  'feed.resume',
  'feed.revive',
  'feed.relay',
  'feed.global',
  'dead.retry',
  'dead.dismiss',
  'lease.retryNow',
  'member.signOut',
  'code.create',
  'code.addUses',
  'code.revoke',
  'code.restore',
  'hold.cancel',
  'invite.address',
] as const
export type AdminActionName = (typeof ADMIN_ACTIONS)[number]

export function isAdminAction(value: unknown): value is AdminActionName {
  return typeof value === 'string' && (ADMIN_ACTIONS as readonly string[]).includes(value)
}

/**
 * The actions an undo can reverse: each sets a value, and its inverse restores the one it replaced
 * while nothing else has changed it since. The rest are one-shot (a fetch, a check, a retry).
 */
export const UNDOABLE_ACTIONS = [
  'site.feature',
  'site.list',
  'site.hide',
  'site.restore',
  'site.topics',
  'site.translationOff',
  'site.translationOn',
  'claim.dismiss',
  'claim.remove',
  'feed.pause',
  'feed.resume',
  'feed.relay',
  'feed.global',
  'dead.dismiss',
  'code.revoke',
  'code.restore',
] as const satisfies readonly AdminActionName[]

/** Actions that ask for a word before they run, and what they ask for. */
export const ACTION_INPUT = {
  'claim.reject': 'reason',
  'code.addUses': 'uses',
  'code.create': 'code',
  'invite.address': 'email',
} as const satisfies Partial<Record<AdminActionName, string>>

/** Actions the console confirms before sending: hard to take back, or felt by someone else. */
export const ACTION_CONFIRM = [
  'claim.vouch',
  'claim.remove',
  'member.signOut',
  'code.revoke',
  'hold.cancel',
] as const satisfies readonly AdminActionName[]

/** Free text an operator may give: a rejection's reason, kept as the claim's error. */
export const ADMIN_REASON_MAX = 300

export type AdminActArgs = {
  /** `site.topics`: the whole new list. */
  topics?: string[]
  /** `claim.reject`. */
  reason?: string
  /** `code.create`, `code.addUses`. */
  uses?: number
  /** `code.create`. */
  code?: string
  /** `invite.address`. */
  email?: string
}

export type AdminActRequest = {
  action: AdminActionName
  /** What it acts on; empty for `code.create` and `invite.address`. A bulk action names several. */
  ids: string[]
  args?: AdminActArgs
}

/** Why an action did not apply to one target. */
export const ADMIN_ACT_ERRORS = [
  'not_found',
  'not_applicable',
  'invalid',
  'taken',
  'no_relay',
  'limit',
] as const
export type AdminActError = (typeof ADMIN_ACT_ERRORS)[number]

export type AdminActResponse = {
  /** Targets the action changed. */
  done: string[]
  failed: { id: string; error: AdminActError }[]
  /** Present when something undoable changed: post it to `/undo` to take it back. */
  undo: { group: string } | null
}

/** `/undo`: `changed_since` when any target moved on after the action, and nothing is restored. */
export type AdminUndoResponse = { restored: number } | { error: 'not_found' | 'changed_since' }

/** A member as the console names them; never more than the public card plus the handle. */
export type AdminPerson = { id: string; handle: string; name: string | null }

/** What an audit row records: a console action, an undo, or the CLI granting the console. */
export type AdminAuditAction = AdminActionName | 'undo' | 'admin.grant' | 'admin.ungrant'

/** One audit row: who did what to which target, and what it replaced. */
export type AdminHistoryEntry = {
  id: number
  at: number
  /** Null for the operator's CLI, or a member since deleted. */
  actor: AdminPerson | null
  action: AdminAuditAction
  targetKind: string
  targetKey: string
  /** For `undo`, the action it reversed. */
  undid?: AdminActionName
  from?: unknown
  to?: unknown
}

/** A ledger's answer: every row in the filter (up to `ADMIN_LIST_LIMIT`), and each filter's size. */
export type AdminList<R, A extends LedgerArea = LedgerArea> = {
  counts: Record<AdminFilter<A>, number>
  rows: R[]
  /** True when the filter held more than the limit; the search narrows it. */
  truncated: boolean
}

export const ADMIN_LIST_LIMIT = 500

/** A ledger row's common fields: its id and what can be done to it now. */
export type AdminRowBase = { id: string; actions: AdminActionName[] }

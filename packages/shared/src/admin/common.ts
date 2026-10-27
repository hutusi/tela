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
  'reports',
  'sites',
  'feeds',
  'discover',
  'people',
  'invites',
  'apps',
  'translation',
  'system',
  'settings',
] as const
export type AdminArea = (typeof ADMIN_AREAS)[number]

/** Each ledger's filters; the first is where the area opens. */
export const ADMIN_FILTERS = {
  claims: ['review', 'checking', 'verified'],
  // Reports of public content (ADR 0059), one row per thing reported: `open` is the queue.
  reports: ['open', 'resolved', 'dismissed'],
  sites: ['discover', 'private', 'attention', 'hidden'],
  feeds: ['failing', 'timeout', 'dead', 'paused', 'merged', 'fetching'],
  // `candidates` is the review queue (ADR 0041), "To review"; `dismissed`, the blogs judged not
  // for Discover, which three readers can still list. `blogrolls` lists members' public
  // blogrolls (ADR 0050), not blogs: its rows are `AdminBlogrollRow`s.
  discover: ['candidates', 'featured', 'listed', 'dismissed', 'hidden', 'blogrolls'],
  // `suspended`: members an operator suspended (ADR 0059), who are in neither of the others.
  people: ['admins', 'members', 'suspended'],
  invites: ['codes', 'waiting', 'revoked'],
  // Approved apps (ADR 0064): what members may connect, what only an owner tests, what is cut off.
  apps: ['approved', 'draft', 'suspended'],
  translation: ['blogs', 'jobs', 'models'],
  system: ['dead', 'retrying', 'resolved'],
  // Every runtime setting (ADR 0056), and those a stored row overrides.
  settings: ['all', 'changed'],
} as const satisfies Record<Exclude<AdminArea, 'overview'>, readonly string[]>
export type LedgerArea = keyof typeof ADMIN_FILTERS
export type AdminFilter<A extends LedgerArea = LedgerArea> = (typeof ADMIN_FILTERS)[A][number]

export function isLedgerArea(value: unknown): value is LedgerArea {
  // Own keys only: `in` would also say yes to `constructor` and `__proto__`.
  return typeof value === 'string' && Object.hasOwn(ADMIN_FILTERS, value)
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
 * request names a site, claim, feed, blogroll, dead letter, lease (`kind:key`), member, code or
 * hold.
 */
export const ADMIN_ACTIONS = [
  'site.feature',
  'site.list',
  'site.dismiss',
  'site.hide',
  'site.restore',
  'site.topics',
  'site.translationOff',
  'site.translationOn',
  'site.feedOnly',
  'site.feedAll',
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
  'blogroll.hide',
  'blogroll.restore',
  'dead.retry',
  'dead.dismiss',
  'lease.retryNow',
  'member.signOut',
  'member.suspend',
  'member.unsuspend',
  'member.delete',
  'report.resolve',
  'report.dismiss',
  'setting.set',
  'code.create',
  'code.addUses',
  'code.revoke',
  'code.restore',
  'hold.cancel',
  'invite.address',
  'app.create',
  'app.edit',
  'app.approve',
  'app.suspend',
  'app.restore',
  'app.endConnections',
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
  'site.dismiss',
  'site.hide',
  'site.restore',
  'site.topics',
  'site.translationOff',
  'site.translationOn',
  'site.feedOnly',
  'site.feedAll',
  'claim.dismiss',
  'claim.remove',
  'feed.pause',
  'feed.resume',
  'feed.relay',
  'feed.global',
  'blogroll.hide',
  'blogroll.restore',
  'dead.dismiss',
  'member.suspend',
  'member.unsuspend',
  'report.resolve',
  'report.dismiss',
  'setting.set',
  'code.revoke',
  'code.restore',
  'app.edit',
  'app.approve',
  'app.suspend',
  'app.restore',
] as const satisfies readonly AdminActionName[]

/**
 * What each action writes that an undo would restore. A later action stands in an undo's way only
 * when it wrote something the same on the same target: Fetch now after Feature leaves the listing
 * as Feature set it. A fetch, a check, a retry or a sign-out writes nothing an undo restores
 * (null). The claim's own actions are one thing, since each moves its status or review together.
 */
export const ACTION_WRITES = {
  // A blog's review for Discover (ADR 0041) is written by List, Feature and Hide with its
  // listing, and by Not for Discover alone: a later List or Hide stands in the way of undoing a
  // dismissal, but a dismissal, which changes no listing, is no listing chosen since.
  'site.feature': ['listing', 'review'],
  'site.list': ['listing', 'review'],
  'site.dismiss': 'review',
  'site.hide': ['listing', 'review'],
  'site.restore': 'listing',
  'site.topics': 'topics',
  'site.translationOff': 'translation',
  'site.translationOn': 'translation',
  // "Only use what my feed provides" (ADR 0061), as its writer can set it on the Dashboard.
  'site.feedOnly': 'feedOnly',
  'site.feedAll': 'feedOnly',
  'site.fetchAll': null,
  'claim.recheck': 'claim',
  'claim.vouch': 'claim',
  'claim.reject': 'claim',
  'claim.dismiss': 'claim',
  'claim.remove': 'claim',
  'feed.fetch': null,
  'feed.pause': 'status',
  'feed.resume': 'status',
  'feed.revive': 'status',
  'feed.relay': 'region',
  'feed.global': 'region',
  // Whether Discover may list a blogroll (ADR 0050): the operator's `hidden_at`, nothing else.
  'blogroll.hide': 'hidden',
  'blogroll.restore': 'hidden',
  'dead.retry': 'resolution',
  'dead.dismiss': 'resolution',
  'lease.retryNow': null,
  'member.signOut': null,
  // A member's standing (ADR 0059): suspended or not; a deletion ends it for good.
  'member.suspend': 'standing',
  'member.unsuspend': 'standing',
  'member.delete': 'standing',
  'report.resolve': 'report',
  'report.dismiss': 'report',
  'setting.set': 'value',
  'code.create': 'code',
  'code.addUses': 'uses',
  'code.revoke': 'revoked',
  'code.restore': 'revoked',
  'hold.cancel': 'hold',
  'invite.address': null,
  // An app's registration (ADR 0064): its settings, and where it stands. Ending its connections
  // ends members' grants, which nothing gives back.
  'app.create': 'app',
  'app.edit': 'appSettings',
  'app.approve': 'appStatus',
  'app.suspend': 'appStatus',
  'app.restore': 'appStatus',
  'app.endConnections': null,
} as const satisfies Record<AdminActionName, string | readonly string[] | null>

/** What an action writes that an undo would restore, as a list (empty for none). */
export function writesOf(action: AdminActionName): readonly string[] {
  const writes: string | readonly string[] | null = ACTION_WRITES[action]
  return writes === null ? [] : typeof writes === 'string' ? [writes] : writes
}

/** The actions that write `what`. */
export function actionsWriting(what: string): AdminActionName[] {
  return (Object.keys(ACTION_WRITES) as AdminActionName[]).filter((action) =>
    writesOf(action).includes(what),
  )
}

/**
 * The actions whose later use stands in the way of an undo of `action`: those that wrote any of
 * what it wrote, on the same target.
 */
export function actionsCrossing(action: AdminActionName): AdminActionName[] {
  const writes = writesOf(action)
  return (Object.keys(ACTION_WRITES) as AdminActionName[]).filter((other) =>
    writesOf(other).some((what) => writes.includes(what)),
  )
}

/** Actions that ask for a word before they run, and what they ask for. */
export const ACTION_INPUT = {
  'claim.reject': 'reason',
  'code.addUses': 'uses',
  'code.create': 'code',
  'invite.address': 'email',
  'app.create': 'app',
  'app.edit': 'app',
} as const satisfies Partial<Record<AdminActionName, string>>

/** Actions the console confirms before sending: hard to take back, or felt by someone else. */
export const ACTION_CONFIRM = [
  'claim.vouch',
  'claim.remove',
  'member.signOut',
  'member.suspend',
  'member.delete',
  'code.revoke',
  'hold.cancel',
  'app.suspend',
  'app.endConnections',
] as const satisfies readonly AdminActionName[]

/**
 * The most targets one action may name, and so the most rows the console lets anyone check at
 * once. Each target is a batch of its own, and a Worker invocation makes at most 1,000 D1
 * queries: 500 checked rows would be refused whole, not acted on in part.
 */
export const ADMIN_BULK_MAX = 50

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
  /** `setting.set`: the new value, checked by `parseSetting` for the key the request names. */
  value?: unknown
  /** `app.create`, `app.edit`: the app's settings, checked by `parseAppSettings`. */
  app?: unknown
}

export type AdminActRequest = {
  action: AdminActionName
  /**
   * What it acts on; empty for `code.create`, `invite.address` and `app.create`. A bulk action
   * names several.
   */
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

/**
 * What an audit row records: a console action, an undo, the CLI granting the console, or a member
 * closing their own account (ADR 0058), which the console shows beside an operator's deletion.
 */
export type AdminAuditAction =
  | AdminActionName
  | 'undo'
  | 'admin.grant'
  | 'admin.ungrant'
  | 'account.delete'

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

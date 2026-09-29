/**
 * The pull half of the sync protocol (ADR 0025).
 *
 * - `GET /api/v1/sync?cursor=0` is a snapshot: everything in the member's horizon, read in one
 *   batch, with `reset` set so the client replaces what it holds.
 * - Any other cursor is a delta: rows written after it. A subscription newer than the cursor
 *   brings its feed's horizon snapshot along, since those articles were written before it.
 * - A page ends on a seq boundary. `more` means pull again from `cursor` straight away.
 * - SQLite has one writer, so seq order is commit order with no gaps; a row the client has not
 *   seen always has a seq above its cursor.
 */
import type { SyncRows, Tombstone } from './rows'

/** Days of articles the reader holds and counts as unread (ADR 0009's horizon). */
export const HORIZON_DAYS = 30

/** Rows per table in one delta page. */
export const PAGE_ROWS = 1000

/**
 * Oldest client the API still speaks to. A pull from an older one is answered 409 `upgrade`, so a
 * stale cached app shell reloads instead of misreading rows (the shell is cached, ADR 0025).
 */
export const MIN_CLIENT = 1
/** The request header a client names its protocol version in. */
export const CLIENT_HEADER = 'x-tela-client'
/**
 * The request header a client names the account its device store belongs to in. Tabs of one
 * browser share the session cookie, so after another tab signs in as someone else this tab's
 * rows, cursor and unsent changes are still the first account's. tela-api answers 409
 * `account_changed` instead of mixing the second account's rows into them (a pull) or applying
 * the first account's changes to the second (a push).
 */
export const MEMBER_HEADER = 'x-tela-member'

export type PullResponse = {
  /** Pull from here next. */
  cursor: number
  /** The page ended early: pull again from `cursor` now. */
  more: boolean
  /** A snapshot: drop everything held and take these rows. */
  reset: boolean
  rows: SyncRows
  tombstones: Tombstone[]
}

export const emptyRows = (): SyncRows => ({
  profile: [],
  prefs: [],
  subscriptions: [],
  feeds: [],
  sites: [],
  articles: [],
  titles: [],
  states: [],
  recommendations: [],
  highlights: [],
  claims: [],
  translations: [],
})

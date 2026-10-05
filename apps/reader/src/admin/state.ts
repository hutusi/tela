/**
 * A ledger's state, which the address owns alone (AGENTS gotchas: two owners of one piece of
 * state is the bug): the filter, the search, the open record and the sort live in
 * `/admin/<area>?f=&q=&id=&sort=&dir=`, so Back, a reload and a copied link all show what was
 * shown. Nothing here is a hook: a key handler parses `window.location` when the key is pressed,
 * never a value a render bound earlier, and the tests run these as they are.
 */
import {
  ADMIN_FILTERS,
  type AdminFilter,
  type AdminRowBase,
  isAdminFilter,
  type LedgerArea,
} from '@tela/shared/admin'
import type { AnyAreaSpec } from './area'

/** What a ledger sorts by: the name, one of the three middle columns, or the status. */
export const SORT_KEYS = ['name', 'c1', 'c2', 'c3', 'status'] as const
export type SortKey = (typeof SORT_KEYS)[number]
export type SortDir = 'asc' | 'desc'

export type LedgerState = {
  filter: AdminFilter
  /** The search as sent to the server; empty for none. */
  q: string
  /** The open record's row id. */
  id: string | null
  sort: SortKey | null
  /** Meaningful only with a sort; `asc` otherwise. */
  dir: SortDir
}

/** Longer than any name, address or handle a search is for; a pasted page is not a search. */
const Q_MAX = 200
/** Longer than any id a row has (a lease's `kind:key` is the longest). */
const ID_MAX = 300

export function defaultFilter(area: LedgerArea): AdminFilter {
  return ADMIN_FILTERS[area][0]
}

/** The state an address holds. Whatever it holds that is no state of this area reads as unset. */
export function parseLedgerState(area: LedgerArea, params: URLSearchParams): LedgerState {
  const f = params.get('f')
  const q = params.get('q') ?? ''
  const id = params.get('id')
  const sort = params.get('sort')
  const validSort = (SORT_KEYS as readonly string[]).includes(sort ?? '') ? (sort as SortKey) : null
  return {
    filter: isAdminFilter(area, f) ? f : defaultFilter(area),
    q: q.length <= Q_MAX ? q : q.slice(0, Q_MAX),
    id: id && id.length <= ID_MAX ? id : null,
    sort: validSort,
    dir: validSort && params.get('dir') === 'desc' ? 'desc' : 'asc',
  }
}

/** The query string for a state, `?…` or empty: defaults are left out, so a plain link is short. */
export function ledgerSearch(area: LedgerArea, state: Partial<LedgerState>): string {
  const params = new URLSearchParams()
  if (state.filter && state.filter !== defaultFilter(area)) params.set('f', state.filter)
  if (state.q) params.set('q', state.q)
  if (state.id) params.set('id', state.id)
  if (state.sort) {
    params.set('sort', state.sort)
    if (state.dir === 'desc') params.set('dir', 'desc')
  }
  const query = params.toString()
  return query ? `?${query}` : ''
}

export function ledgerHref(area: LedgerArea, state: Partial<LedgerState> = {}): string {
  return `/admin/${area}${ledgerSearch(area, state)}`
}

/**
 * The ledger that acts on an audit entry's target, and the row id it gives that target. The audit
 * log keys a target as its own table does; the ledgers that list two kinds of row tell them apart
 * by a prefix (`dead:<n>` and `lease:<kind>:<key>` in System, `code:<CODE>` and `hold:<n>` in
 * Invitations), so a bare key there names no row. Null for a kind no ledger lists.
 */
export function auditedRow(kind: string, key: string): { area: LedgerArea; id: string } | null {
  switch (kind) {
    case 'site':
      return { area: 'sites', id: key }
    case 'feed':
      return { area: 'feeds', id: key }
    case 'claim':
      return { area: 'claims', id: key }
    case 'member':
      return { area: 'people', id: key }
    case 'code':
      return { area: 'invites', id: `code:${key}` }
    case 'hold':
      return { area: 'invites', id: `hold:${key}` }
    case 'dead':
      return { area: 'system', id: `dead:${key}` }
    case 'lease':
      return { area: 'system', id: `lease:${key}` }
    default:
      return null
  }
}

/** Where a change leads from the address `search` holds now: read at the moment of the change. */
export function patchedHref(area: LedgerArea, search: string, patch: Partial<LedgerState>): string {
  const now = parseLedgerState(area, new URLSearchParams(search))
  return ledgerHref(area, { ...now, ...patch })
}

/** A header click: off, then ascending, then descending, then off again. */
export function nextSort(
  state: Pick<LedgerState, 'sort' | 'dir'>,
  key: SortKey,
): Pick<LedgerState, 'sort' | 'dir'> {
  if (state.sort !== key) return { sort: key, dir: 'asc' }
  if (state.dir === 'asc') return { sort: key, dir: 'desc' }
  return { sort: null, dir: 'asc' }
}

export type SortValue = number | string | null

/**
 * Numbers by size and words as a person reads them (`feed 9` before `feed 10`); a missing value
 * (null, empty, or the dash a cell shows for nothing) goes last whichever way the column runs, so
 * a sort never opens on a screen of blanks.
 */
export function compareSort(a: SortValue, b: SortValue, dir: SortDir): number {
  const missing = (v: SortValue) => v === null || v === '' || v === '—'
  if (missing(a) || missing(b)) return missing(a) === missing(b) ? 0 : missing(a) ? 1 : -1
  const sign = dir === 'desc' ? -1 : 1
  if (typeof a === 'number' && typeof b === 'number') return (a - b) * sign
  if (typeof a === 'number') return -1 * sign
  if (typeof b === 'number') return 1 * sign
  return (
    String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' }) * sign
  )
}

/** The rows in a sort's order; ties keep the server's order. */
export function sortRows<R>(rows: readonly R[], value: (row: R) => SortValue, dir: SortDir): R[] {
  return rows
    .map((row, at) => ({ row, at, v: value(row) }))
    .sort((x, y) => compareSort(x.v, y.v, dir) || x.at - y.at)
    .map((x) => x.row)
}

/** What a sort key reads from a row of an area: a column's number where it has one. */
export function sortValueOf(spec: AnyAreaSpec, key: SortKey): (row: AdminRowBase) => SortValue {
  if (key === 'name') return (row) => spec.name.title(row)
  if (key === 'status') return (row) => spec.status(row).label
  const column = spec.columns[Number(key.slice(1)) - 1]
  if (!column) return () => null
  const { number, text } = column
  return number ? (row) => number(row) : (row) => text(row)
}

/**
 * The row the open record shows, and its place in the list as shown (-1 for none). A listed row
 * is itself. A record no filter lists (a claim rejected or removed, a row past the list's limit)
 * is the row its detail carries, once the detail has loaded: it has no place, so no "2 of 9" and
 * no previous or next. Null while there is neither.
 */
export function openedRecord<R, D>(
  rows: readonly R[],
  ids: readonly string[],
  id: string | null,
  detail: D | null,
  rowOf: ((detail: D) => R) | undefined,
): { row: R | null; index: number } {
  if (id === null) return { row: null, index: -1 }
  const index = ids.indexOf(id)
  if (index >= 0) return { row: rows[index] ?? null, index }
  return { row: detail !== null && rowOf ? rowOf(detail) : null, index: -1 }
}

/**
 * Where the selection goes after an action on `acted`: the row itself while it is still listed,
 * else the next one the list showed before that is still there, else the one before it (the
 * design's "acting on it moves you to the next one"), else the first row listed now. Null when
 * nothing is left, or when the list never showed the row.
 */
export function nextAfterAct(
  before: readonly string[],
  after: readonly string[],
  acted: string,
): string | null {
  const still = new Set(after)
  if (still.has(acted)) return acted
  const at = before.indexOf(acted)
  // A row the list never showed has no place to move on from.
  if (at === -1) return null
  for (let i = at + 1; i < before.length; i++) {
    const id = before[i]
    if (id !== undefined && still.has(id)) return id
  }
  for (let i = at - 1; i >= 0; i--) {
    const id = before[i]
    if (id !== undefined && still.has(id)) return id
  }
  return after[0] ?? null
}

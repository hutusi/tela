/**
 * What an area gives the ledger (ADR 0039, the design's "Ledger, refined"): how to load its rows
 * and one record, how to show a row, and the record panel's body. The ledger owns the rest: the
 * search box, filter pills, sorting, the focus and selection, the panel's frame, the bulk bar,
 * the keys, confirmations, input prompts and the undo toast. Every string an area returns is
 * already translated (`useTranslations('admin.<group>')` in the area's hook).
 */
import type {
  AdminActArgs,
  AdminActionName,
  AdminFilter,
  AdminList,
  AdminRowBase,
  AdminTone,
  LedgerArea,
} from '@tela/shared/admin'
import type { ReactNode } from 'react'

/** A status dot and its words. */
export type Status = { tone: AdminTone; label: string }

/** One of a row's three middle columns, shown while no record is open. */
export type Column<R> = {
  label: string
  /** The cell's words; also what the column sorts by unless `number` is given. */
  text: (row: R) => string
  /** Sort by this instead, where a column is a count or a time. */
  number?: (row: R) => number | null
}

/**
 * Run an action from inside a record (a topic chip, a link that acts): the ledger's own path. One
 * action at a time: false, and nothing sent, while another is out.
 */
export type Act = (action: AdminActionName, ids?: string[], args?: AdminActArgs) => boolean

export type RecordProps<R, D> = {
  row: R
  /** Null while the record is loading, or when it failed to. */
  detail: D | null
  act: Act
  /** An action is out: a control that acts waits for it. */
  busy: boolean
  /** Open another area's record: a claim's site, a site's owner. */
  open: (area: LedgerArea, id: string) => void
}

export type AreaSpec<A extends LedgerArea, R extends AdminRowBase, D> = {
  area: A
  filterLabel: (filter: AdminFilter<A>) => string
  searchHint: string
  load: (filter: AdminFilter<A>, q: string, signal?: AbortSignal) => Promise<AdminList<R, A> | null>
  /** Null for an area whose rows say everything (Translation). */
  loadDetail: ((id: string, signal?: AbortSignal) => Promise<D | null>) | null
  /**
   * The row a record's detail carries. A record no filter lists (a rejected claim, a row past the
   * list's limit) opens from it: there is no list row to show, but the detail has one.
   */
  rowOf?: (detail: D) => R
  name: {
    label: string
    title: (row: R) => string
    sub: (row: R) => string
    /** The square at the start of the row: a favicon, an avatar, or a letter. */
    tile: (row: R) => ReactNode
  }
  columns: readonly [Column<R>, Column<R>, Column<R>]
  status: (row: R) => Status
  /** The record panel's body, under the panel's header and above its actions. */
  Record: (props: RecordProps<R, D>) => ReactNode
  /** Over the filters: Translation's totals, System's health. */
  Header?: () => ReactNode
  /** Actions on several checked rows. */
  bulk: readonly AdminActionName[]
  /** Actions that make something new, offered beside the search (New code, Invite). */
  create?: readonly AdminActionName[]
  /** Words for an action on a row, where the shell's own would mislead (Unfeature, not Restore). */
  actionLabel?: (row: R, action: AdminActionName) => string | undefined
  /** The first filter is a queue: empty, it says "Queue clear." */
  queue?: boolean
}

/** Any area, for the shell's table of them. */
// biome-ignore lint/suspicious/noExplicitAny: the shell renders each area with its own types
export type AnyAreaSpec = AreaSpec<any, any, any>

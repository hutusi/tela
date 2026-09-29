/**
 * The device's store (ADR 0025): confirmed tables from pulls, the member's pending mutations, and
 * the view the UI renders, which is the two combined. React reads it through
 * `useSyncExternalStore`; the snapshot changes identity exactly when the view does.
 *
 * Every change is written through to storage, so a reload, a crash or a day offline loses
 * nothing the member did.
 */
import {
  type ArticleRow,
  applyPull,
  type Confirmed,
  emptyTables,
  type Mutation,
  type Pending,
  type PullResponse,
  type PushResponse,
  rowsOf,
  settle,
  type TableRows,
  type Tables,
  tablesFromRows,
  view,
} from '@tela/sync'
import type { Persistence } from './db'

/** A mutation as the UI states it: the store adds the id and the time. */
export type MutationInput = Mutation extends infer M
  ? M extends { mid: string; at: number }
    ? Omit<M, 'mid' | 'at'>
    : never
  : never

export type Snapshot = { version: number; tables: Tables; pendingCount: number }

const newMid = () =>
  typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`

export class LocalStore {
  private confirmed: Confirmed = { cursor: 0, tables: emptyTables() }
  private pending: Pending[] = []
  private current: Snapshot = { version: 0, tables: emptyTables(), pendingCount: 0 }
  private listeners = new Set<() => void>()
  /** Called after every local mutation, so the sync engine can push. */
  onMutation: (() => void) | null = null
  userId: string | null = null
  /**
   * Articles the member reached outside what the device syncs (a search hit older than the
   * horizon): held for this visit only, so the reader can open them like any other.
   */
  private transient = new Map<number, ArticleRow>()
  /** What those articles' feeds are called, since the device holds no row for them. */
  private transientNames = new Map<number, string>()

  remember(articles: ArticleRow[], source?: string | null): void {
    for (const a of articles) {
      this.transient.set(a.id, a)
      if (source) this.transientNames.set(a.feedId, source)
    }
  }

  /** An article from the synced tables, else one remembered this visit. */
  article(tables: Tables, id: number): ArticleRow | undefined {
    return tables.articles.get(id) ?? this.transient.get(id)
  }

  /** The name a remembered article's feed was shown under. */
  sourceName(feedId: number): string {
    return this.transientNames.get(feedId) ?? ''
  }

  constructor(
    private readonly persistence: Persistence,
    private readonly now: () => number = Date.now,
  ) {}

  /** Load what the device kept from its last visit. */
  async open(): Promise<void> {
    const saved = await this.persistence.load()
    this.userId = saved.userId
    this.confirmed = {
      cursor: saved.cursor,
      tables: saved.rows ? tablesFromRows(saved.rows) : emptyTables(),
    }
    this.pending = saved.pending
    this.recompute()
  }

  get cursor(): number {
    return this.confirmed.cursor
  }

  /** Whether the device holds anything a member synced: it can render before the network. */
  get hasData(): boolean {
    return this.confirmed.tables.profile !== null
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot = (): Snapshot => this.current

  private recompute() {
    this.current = {
      version: this.current.version + 1,
      tables: view(this.confirmed, this.pending),
      pendingCount: this.pending.length,
    }
    for (const listener of this.listeners) listener()
  }

  /** Make a change now, on this device, and queue it for the server. */
  mutate(input: MutationInput): void {
    const mutation = { ...input, mid: newMid(), at: this.now() } as Mutation
    this.pending = [...this.pending, { mutation }]
    this.recompute()
    void this.persistence.saveMeta({ pending: this.pending })
    this.onMutation?.()
  }

  /** Fold a pull in. Only the tables it touched are rewritten. */
  async applyPull(pull: PullResponse): Promise<void> {
    const before = this.confirmed.tables
    this.confirmed = applyPull(this.confirmed, pull)
    this.pending = settle(this.confirmed, this.pending)
    this.recompute()
    const rows = rowsOf(this.confirmed.tables)
    const changed: Partial<TableRows> = {}
    for (const name of Object.keys(rows) as (keyof TableRows)[]) {
      const held = before[name as keyof Tables]
      const now = this.confirmed.tables[name as keyof Tables]
      const touched =
        pull.reset ||
        (name === 'profile' ? pull.rows.profile.length > 0 : pull.rows[name].length > 0) ||
        // Pruning after a pull can drop articles, states and titles no row of theirs named; it
        // only ever removes, so a changed size is how to tell. (Every map is a fresh copy after
        // a pull, so identity says nothing.)
        (held instanceof Map && now instanceof Map && held.size !== now.size)
      if (touched) (changed as Record<string, unknown>)[name] = rows[name]
    }
    await this.persistence.saveTables(changed)
    await this.persistence.saveMeta({ cursor: this.confirmed.cursor, pending: this.pending })
  }

  /** What to push next: mutations the server has not answered for, oldest first. */
  unsent(limit = 50): Mutation[] {
    return this.pending
      .filter((p) => p.ackedAt === undefined)
      .slice(0, limit)
      .map((p) => p.mutation)
  }

  /** Record a push's answer: acknowledged ones wait for a pull; refused ones are undone. */
  async acknowledge(res: PushResponse): Promise<void> {
    const applied = new Set(res.applied)
    const refused = new Set(res.rejected.map((r) => r.mid))
    this.pending = this.pending
      .filter((p) => !refused.has(p.mutation.mid))
      .map((p) => (applied.has(p.mutation.mid) ? { ...p, ackedAt: res.seq } : p))
    this.pending = settle(this.confirmed, this.pending)
    this.recompute()
    await this.persistence.saveMeta({ pending: this.pending })
  }

  /** Whose rows these are; a different member signing in on this browser starts from nothing. */
  async setUser(userId: string): Promise<void> {
    if (this.userId !== null && this.userId !== userId) await this.clear()
    this.userId = userId
    await this.persistence.saveMeta({ userId })
  }

  /** Forget everything: signing out. */
  async clear(): Promise<void> {
    this.confirmed = { cursor: 0, tables: emptyTables() }
    this.pending = []
    this.userId = null
    await this.persistence.clear()
    this.recompute()
  }
}

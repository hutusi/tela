/**
 * The device's store (ADR 0025): confirmed tables from pulls, the member's pending mutations, and
 * the view the UI renders, which is the two combined. React reads it through
 * `useSyncExternalStore`; the snapshot changes identity exactly when the view does.
 *
 * Every change is written through to storage, so a reload, a crash or a day offline loses
 * nothing the member did. Every write names the account it is for, and storage refuses it once
 * the copy is no longer that account's (another tab signed in as someone else, or out): the tab
 * then hears `onLost` and leaves, rather than write one account's rows into another's.
 */
import {
  type ArticleRow,
  applyPull,
  type Confirmed,
  completePull,
  emptyTables,
  type FollowRow,
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
import { newId } from '../lib/id'
import type { Person } from '../views/types'
import type { Change, Persistence } from './db'

/** A mutation as the UI states it: the store adds the id and the time. */
export type MutationInput = Mutation extends infer M
  ? M extends { mid: string; at: number }
    ? Omit<M, 'mid' | 'at'>
    : never
  : never

/** The changes in `before` that `after` no longer holds. */
const gone = (before: readonly Pending[], after: readonly Pending[]): string[] => {
  const kept = new Set(after.map((p) => p.mutation.mid))
  return before.filter((p) => !kept.has(p.mutation.mid)).map((p) => p.mutation.mid)
}

export type Snapshot = { version: number; tables: Tables; pendingCount: number }

export class LocalStore {
  private confirmed: Confirmed = { cursor: 0, tables: emptyTables() }
  private pending: Pending[] = []
  private current: Snapshot = { version: 0, tables: emptyTables(), pendingCount: 0 }
  private listeners = new Set<() => void>()
  /** Called after every local mutation, so the sync engine can push. */
  onMutation: (() => void) | null = null
  /**
   * Called once when storage refuses a write because the copy is no longer this tab's account:
   * nothing this tab holds belongs to whoever has it now.
   */
  onLost: (() => void) | null = null
  /**
   * Called when a pull changes whom the server has the member follow, with those rows (as they
   * were, for an unfollow): a page cached from before still counts the old state (ADR 0031).
   */
  onFollowsConfirmed: ((rows: FollowRow[]) => void) | null = null
  /** The account this tab holds: every write is made for it, and every request names it. */
  userId: string | null = null
  /**
   * The mark on the copy as this tab loaded it (`Persisted.unverified`): an earlier build ran
   * here since the copy was claimed, and no boot trusts it before /me. A claim clears the mark
   * that stood when its /me was asked (`mark()`, read just before), and this one when it is given
   * none.
   */
  unverified: string | null = null
  /**
   * Moves on whenever the tab stops holding what it held: another account, or none. An answer to
   * a request sent before is for rows the tab no longer has, so it is dropped (`applyPull` and
   * `acknowledge` take the epoch their request was sent in).
   */
  epoch = 0
  /** The epoch `onLost` was last called in: once is enough. */
  private lostIn = -1
  /**
   * Articles the member reached outside what the device syncs (a search hit older than the
   * horizon): held for this visit only, so the reader can open them like any other.
   */
  private transient = new Map<number, ArticleRow>()
  /** What those articles' feeds are called, since the device holds no row for them. */
  private transientNames = new Map<number, string>()
  /**
   * Members a page showed this visit, by account id: a follow made from that page is named by it
   * until the pull brings the follow row with its name (ADR 0031).
   */
  private people = new Map<string, Person>()

  rememberPeople(people: readonly Person[]): void {
    for (const p of people) this.people.set(p.id, p)
  }

  /** A member a page showed this visit. */
  person(id: string): Person | undefined {
    return this.people.get(id)
  }

  /**
   * Whom the member follows as the server has said, sorted: the confirmed rows, without the
   * changes still on their way. What the server answers about the people followed is about
   * these, so a page asks again when they change, not when a prediction does (ADR 0031).
   */
  confirmedFollowees = (): string => [...this.confirmed.tables.follows.keys()].sort().join(',')

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
    this.userId = saved.owner
    this.unverified = saved.unverified
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

  /** Hold `owner` from now on, and nothing yet: whatever was held is not theirs. */
  private reset(owner: string | null) {
    this.epoch++
    this.userId = owner
    this.confirmed = { cursor: 0, tables: emptyTables() }
    this.pending = []
    this.transient = new Map()
    this.transientNames = new Map()
    this.people = new Map()
    this.recompute()
  }

  /** Write through as `owner`. A refusal means the copy is someone else's now. */
  private async write(owner: string, epoch: number, change: Change): Promise<void> {
    if (await this.persistence.commit(owner, change)) return
    // Refused after the tab itself moved on (a sign-in here, or a forget): nothing it holds is lost.
    if (epoch !== this.epoch || this.lostIn === epoch) return
    this.lostIn = epoch
    this.onLost?.()
  }

  /** Make a change now, on this device, and queue it for the server. */
  mutate(input: MutationInput): void {
    const owner = this.userId
    // Nobody's rows are held: the change would be no one's, and could go to anyone.
    if (owner === null) return
    const mutation = { ...input, mid: newId(), at: this.now() } as Mutation
    const entry: Pending = { mutation }
    this.pending = [...this.pending, entry]
    this.recompute()
    void this.write(owner, this.epoch, { put: [entry] })
    this.onMutation?.()
  }

  /**
   * Fold in a pull asked for in `epoch`, unless the tab has stopped holding those rows since. Only
   * the tables it touched are rewritten, in one write with the cursor, which storage refuses
   * when it would move the stored cursor back over newer tables another tab of this account
   * wrote (`Change` in db.ts).
   */
  async applyPull(given: PullResponse, epoch: number): Promise<void> {
    const owner = this.userId
    if (owner === null || epoch !== this.epoch) return
    // Every table this build knows, so the loop below never reads one an older tela-api left out.
    const pull = completePull(given)
    const before = this.confirmed.tables
    const from = this.confirmed.cursor
    const held = this.pending
    this.confirmed = applyPull(this.confirmed, pull)
    const after = this.confirmed.tables.follows
    const changedFollows = [
      ...[...after.values()].filter((f) => !before.follows.has(f.userId)),
      ...[...before.follows.values()].filter((f) => !after.has(f.userId)),
    ]
    if (changedFollows.length > 0) this.onFollowsConfirmed?.(changedFollows)
    this.pending = settle(this.confirmed, this.pending)
    this.recompute()
    const rows = rowsOf(this.confirmed.tables)
    const changed: Partial<TableRows> = {}
    for (const name of Object.keys(rows) as (keyof TableRows)[]) {
      const was = before[name as keyof Tables]
      const now = this.confirmed.tables[name as keyof Tables]
      const touched =
        pull.reset ||
        (name === 'profile' ? pull.rows.profile.length > 0 : pull.rows[name].length > 0) ||
        // Pruning after a pull can drop articles, states and titles no row of theirs named; it
        // only ever removes, so a changed size is how to tell. (Every map is a fresh copy after
        // a pull, so identity says nothing.)
        (was instanceof Map && now instanceof Map && was.size !== now.size)
      if (touched) (changed as Record<string, unknown>)[name] = rows[name]
    }
    await this.write(owner, epoch, {
      tables: changed,
      cursor: this.confirmed.cursor,
      from,
      whole: rows,
      drop: gone(held, this.pending),
    })
  }

  /** What to push next: mutations the server has not answered for, oldest first. */
  unsent(limit = 50): Mutation[] {
    return this.pending
      .filter((p) => p.ackedAt === undefined)
      .slice(0, limit)
      .map((p) => p.mutation)
  }

  /**
   * Record the answer to a push sent in `epoch`, unless the tab has stopped holding those rows
   * since: acknowledged ones wait for a pull; refused ones are undone.
   */
  async acknowledge(res: PushResponse, epoch: number): Promise<void> {
    const owner = this.userId
    if (owner === null || epoch !== this.epoch) return
    const applied = new Set(res.applied)
    const refused = new Set(res.rejected.map((r) => r.mid))
    const held = this.pending
    this.pending = this.pending
      .filter((p) => !refused.has(p.mutation.mid))
      .map((p) => (applied.has(p.mutation.mid) ? { ...p, ackedAt: res.seq } : p))
    this.pending = settle(this.confirmed, this.pending)
    this.recompute()
    await this.write(owner, epoch, {
      put: this.pending.filter((p) => applied.has(p.mutation.mid)),
      drop: gone(held, this.pending),
    })
  }

  /**
   * The mark on the stored copy as it stands (`Persisted.unverified`). Read just before asking
   * /me: a mark already down is about something /me's answer reflects, so the claim after that
   * answer may clear it, whenever this tab loaded the copy.
   */
  mark(): Promise<string | null> {
    return this.persistence.mark()
  }

  /**
   * The session is `userId`'s: make the stored copy theirs. Anyone else's copy, or one nobody
   * owns, is wiped first, and so is what this tab holds of it. The mark is cleared if it is still
   * `seen`: the one this tab loaded, unless it read the mark again before asking /me. Says
   * whether the tab was holding another account, whose rows its page may still be showing.
   */
  async setUser(userId: string, seen: string | null = this.unverified): Promise<boolean> {
    const previous = this.userId
    // Before the claim, so an answer already on its way for `previous` finds the epoch moved.
    if (previous !== userId) this.reset(userId)
    const wiped = await this.persistence.claim(userId, seen)
    this.unverified = null
    // The copy stopped being this account's after the tab loaded it: what it holds is gone there.
    if (wiped && previous === userId) this.reset(userId)
    return previous !== null && previous !== userId
  }

  /**
   * Nothing this tab holds is the session's any more: another tab signed in as someone else, or
   * the session ended. The stored copy goes too while it is still this tab's account's; if the
   * new account's tab has claimed it already, that one is left alone.
   */
  async forgetAccount(): Promise<void> {
    const owner = this.userId
    // First, so nothing still on its way for the old account lands after this.
    this.reset(null)
    if (owner !== null) await this.persistence.release(owner)
  }

  /** Signing out: forget this account, and only this account's copy, as `forgetAccount`. */
  clear(): Promise<void> {
    return this.forgetAccount()
  }
}

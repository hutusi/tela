/**
 * The device's store (ADR 0025): confirmed tables from pulls, the member's pending mutations, and
 * the view the UI renders, which is the two combined. React reads it through
 * `useSyncExternalStore`; the snapshot changes identity exactly when the view does.
 *
 * Every change is written through to storage, so a reload, a crash or a day offline loses
 * nothing the member did, except one held back for an Undo while its toast shows (`mutate`'s
 * `holdMs`). Every write names the account it is for, and storage refuses it once
 * the copy is no longer that account's (another tab signed in as someone else, or out): the tab
 * then hears `onLost` and leaves, rather than write one account's rows into another's.
 */
import {
  type ArticleRow,
  applyPull,
  blogrollPublicChange,
  blogrollPublicUnsettled,
  type Confirmed,
  completePull,
  emptyTables,
  type FolderRow,
  type FollowRow,
  type Mutation,
  mergeTitles,
  nextTitleIds,
  type Pending,
  type PrivacyFlag,
  type PullResponse,
  type PushResponse,
  privacyChange,
  privacyUnsettled,
  pruneTitlesTo,
  rowsOf,
  settle,
  type TableRows,
  type Tables,
  type TitleRow,
  tablesFromRows,
  titlesIn,
  view,
} from '@tela/sync'
import { newId } from '../lib/id'
import type { Person } from '../views/types'
import { type Change, type Persistence, TABLES, type TitlesHeld } from './db'

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

/** What the store stamped a change with: its id, and the time it was made. */
export type Stamp = { mid: string; at: number }

/** How the store waits: the platform's timers, or a test's. */
export type Timers = {
  set(run: () => void, ms: number): unknown
  clear(handle: unknown): void
}

const platformTimers: Timers = {
  set: (run, ms) => setTimeout(run, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

/** One hold's timer, shared by the changes made under it, and how many of them it still holds. */
type Hold = { handle: unknown; count: number }

export class LocalStore {
  private confirmed: Confirmed = { cursor: 0, tables: emptyTables() }
  /**
   * The tables the confirmed copy holds whole up to its cursor: those the server sent since it was
   * last a snapshot (`Persisted.covered`). A tela-api from before a table leaves it out.
   */
  private covered: ReadonlySet<string> = new Set()
  /**
   * Which language's titles the confirmed tables hold, and whether whole up to the cursor
   * (`TitlesHeld`). Titles are only ever in `lang`: a switch lets the others go at once, and a
   * pull in another language brings none. `lang` null is every language a pull sent, until the
   * store is told the member's (`setReadingLang`).
   */
  private titles: TitlesHeld = { lang: null, whole: false }
  /**
   * Moves on whenever the titles held stop being whole (a switch, a pull in another language,
   * another account): the engine's pass through what is missing is for one round, and starts
   * over in the next (`missingTitles`).
   */
  titlesRound = 0
  /**
   * The titles have changed here since a write that carried them landed: storage left that write
   * out, since another tab had moved the copy past it (`Change.placed`). The next pull's write
   * carries them.
   */
  private titlesDirty = false
  /** Called when the reading language changes, so the sync engine fetches its titles. */
  onLanguage: (() => void) | null = null
  private pending: Pending[] = []
  /**
   * Changes in `pending` held back from the server for an Undo, by id, with the timer that lets
   * them go (`mutate`'s `holdMs`; a `mutateMany` group shares one). Held only in memory, never in
   * storage, until let go.
   */
  private holds = new Map<string, Hold>()
  /** The time the last change was stamped with: the next one is later (`stampAt`). */
  private lastAt = Number.NEGATIVE_INFINITY
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

  /**
   * The member's folders as they would be were every held change taken back (ADR 0046): the view
   * without what an Undo may still retract. A folder whose deletion is held is gone from the view
   * but here, whether the server has it or it was made on this device and is still on its way:
   * its name and its place under the limit are not free until the deletion goes (ADR 0048).
   */
  foldersBeforeHolds = (): ReadonlyMap<string, FolderRow> => this.tablesBeforeHolds().folders

  /**
   * The tables as they would be were every held change taken back (ADR 0046). What a limit counts
   * against: a folder or blogroll whose deletion is held, or a blog whose removal is, keeps its
   * place under the limit until the change goes, or an Undo after something new took that place
   * would push past it, and the server would drop it (ADRs 0048, 0050).
   */
  tablesBeforeHolds = (): Tables =>
    view(
      this.confirmed,
      this.pending.filter((p) => !this.holds.has(p.mutation.mid)),
    )

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
    private readonly timers: Timers = platformTimers,
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
    this.covered = new Set(saved.covered)
    this.titles = saved.titles
    // Only the record's language, whatever another build left in the table beside it; written
    // back with the next pull.
    if (saved.titles.lang !== null) {
      const tables = pruneTitlesTo(this.confirmed.tables, saved.titles.lang)
      if (tables !== this.confirmed.tables) {
        this.confirmed = { ...this.confirmed, tables }
        this.titlesDirty = true
      }
    }
    this.pending = saved.pending
    this.pruneHolds()
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
    this.covered = new Set()
    // The next account's language is its own: told again (`learnWho`, `Routed`).
    this.titles = { lang: null, whole: false }
    this.titlesRound++
    this.titlesDirty = false
    this.pending = []
    // A held change was the old account's: it is never let go into the new one's.
    this.pruneHolds()
    this.transient = new Map()
    this.transientNames = new Map()
    this.people = new Map()
    this.recompute()
  }

  /**
   * Write through as `owner`. A refusal means the copy is someone else's now. Says whether the
   * tables and cursor were written, or left out since another tab had moved the copy past them
   * (`Change` in db.ts).
   */
  private async write(owner: string, epoch: number, change: Change): Promise<boolean> {
    let written = false
    const placed = (yes: boolean) => {
      written = yes
    }
    if (await this.persistence.commit(owner, { ...change, placed })) return written
    // Refused after the tab itself moved on (a sign-in here, or a forget): nothing it holds is lost.
    if (epoch !== this.epoch || this.lostIn === epoch) return false
    this.lostIn = epoch
    this.onLost?.()
    return false
  }

  /** The reading language this device holds titles in; null for every language, until told. */
  get titleLang(): string | null {
    return this.titles.lang
  }

  /** Whether the device holds every title the server has in that language, up to its cursor. */
  get titlesWhole(): boolean {
    return this.titles.whole
  }

  /**
   * The member reads in `lang` now (`readingLangOf`, handed over by the app as the view says it):
   * hold that language's titles only. The others go at once, so the lists show posts as written
   * until the new ones come, and the engine fetches them (`onLanguage`) rather than start over.
   * A copy that held every language (from before the device kept one) held this one whole too.
   */
  setReadingLang(lang: string): void {
    if (this.titles.lang === lang) return
    const before = this.confirmed.tables
    const tables = pruneTitlesTo(before, lang)
    this.titles = { lang, whole: this.titles.lang === null && this.titles.whole }
    if (!this.titles.whole) this.titlesRound++
    if (tables !== before) {
      this.confirmed = { ...this.confirmed, tables }
      this.recompute()
    }
    const owner = this.userId
    if (owner !== null) void this.storeTitles(owner, this.epoch)
    this.onLanguage?.()
  }

  /**
   * The articles held past `after`, by id, still missing a title in the language held: the next
   * page of titles to fetch. None while the language is not known.
   */
  missingTitles(after: number): number[] {
    const lang = this.titles.lang
    return lang === null ? [] : nextTitleIds(this.confirmed.tables, lang, undefined, after)
  }

  /**
   * Fold in titles fetched by id in `lang`, asked for in `epoch`, into the confirmed tables as
   * they are now (a pull may have landed meanwhile): dropped if the tab holds another account or
   * another language since.
   */
  async applyTitles(rows: readonly TitleRow[], lang: string, epoch: number): Promise<void> {
    const owner = this.userId
    if (owner === null || epoch !== this.epoch || lang !== this.titles.lang) return
    const before = this.confirmed.tables
    const tables = mergeTitles(before, rows, lang)
    if (tables === before) return
    this.confirmed = { ...this.confirmed, tables }
    this.recompute()
    await this.storeTitles(owner, epoch)
  }

  /**
   * The engine has asked for every title missing in `lang` in `round`: what the server had is
   * here, and every title written since comes with a pull in `lang`. Whole, unless the round, the
   * language or the account moved meanwhile.
   */
  async titlesFetched(lang: string, epoch: number, round: number): Promise<void> {
    const owner = this.userId
    if (owner === null || epoch !== this.epoch) return
    if (lang !== this.titles.lang || round !== this.titlesRound || this.titles.whole) return
    this.titles = { lang, whole: true }
    await this.storeTitles(owner, epoch)
  }

  /**
   * Store the titles as held, with what they are (`Change.titles`), at the cursor they are held
   * at. Storage leaves them out when another tab has moved the copy past that cursor; the next
   * pull's write carries them then (`titlesDirty`).
   */
  private async storeTitles(owner: string, epoch: number): Promise<void> {
    const { cursor, tables } = this.confirmed
    // Nothing stored to place them beside: the next pull writes everything.
    if (cursor === 0) {
      this.titlesDirty = true
      return
    }
    const written = await this.write(owner, epoch, {
      tables: { titles: [...tables.titles.values()] },
      cursor,
      from: cursor,
      whole: rowsOf(tables),
      covered: [...this.covered],
      titles: { ...this.titles, folded: true },
    })
    if (epoch === this.epoch) this.titlesDirty = !written
  }

  /**
   * The time to stamp the next change with: now, unless that is not later than the last change
   * stamped, or than `after`. So a change made within a millisecond of another, or just after a
   * group whose stamps ran ahead of the clock (`mutateMany`), is still the later one wherever
   * `at` decides.
   */
  private stampAt(after = Number.NEGATIVE_INFINITY): number {
    this.lastAt = Math.max(this.now(), this.lastAt + 1, after + 1)
    return this.lastAt
  }

  /**
   * Make a change now, on this device, and queue it for the server; returns what it was stamped
   * with, or null when the tab holds no account and nothing was made.
   *
   * With `holdMs`, the change is shown at once but held back from the server, so an Undo can take
   * it back before tela-api ever sees it (`retract`): some changes cannot be undone once sent (the
   * read watermark only moves forward, ADR 0025). The caller lets it go once its Undo is gone
   * (`release`); `holdMs` is only the backstop, so that no hold lasts for ever. Nothing made after
   * it is sent before it (`unsent`). It is held in memory only and written to storage when let go:
   * any other tab that booted meanwhile would load it from storage and send it. A crash during the
   * hold drops it, which is the price; leaving the page lets it go first (`releaseHolds`, from the
   * sync engine).
   */
  mutate(input: MutationInput, options: { holdMs?: number } = {}): Stamp | null {
    return this.mutateMany([input], options)[0] ?? null
  }

  /**
   * Make several changes at once: one recompute, one write, one push. Each is stamped later than
   * the one before it, so they keep their order wherever `at` decides, and every one later than
   * `after` when given (an Undo that must come after the change it undoes). With `holdMs`, they
   * are held as `mutate` holds one, on one timer, and go together.
   */
  mutateMany(
    inputs: readonly MutationInput[],
    options: { after?: number; holdMs?: number } = {},
  ): Stamp[] {
    const owner = this.userId
    // Nobody's rows are held: a change would be no one's, and could go to anyone.
    if (owner === null || inputs.length === 0) return []
    const entries: Pending[] = inputs.map((input) => ({
      mutation: { ...input, mid: newId(), at: this.stampAt(options.after) } as Mutation,
    }))
    const stamps = entries.map(({ mutation }) => ({ mid: mutation.mid, at: mutation.at }))
    this.pending = [...this.pending, ...entries]
    if (options.holdMs !== undefined && options.holdMs > 0) {
      const mids = stamps.map((s) => s.mid)
      const hold: Hold = { handle: null, count: mids.length }
      hold.handle = this.timers.set(() => this.letGo(mids), options.holdMs)
      for (const mid of mids) this.holds.set(mid, hold)
      this.recompute()
      return stamps
    }
    this.recompute()
    void this.write(owner, this.epoch, { put: entries })
    this.onMutation?.()
    return stamps
  }

  /**
   * Take back changes still held (`holdMs`): they leave the view, and since they were never
   * written or sent, nothing else has to. False, and nothing taken back, unless every one of them
   * is held: one let go already is on its way to the server, and has to be undone another way.
   */
  retract(...mids: string[]): boolean {
    if (mids.length === 0 || !mids.every((mid) => this.holds.has(mid))) return false
    for (const mid of mids) this.unhold(mid)
    const taken = new Set(mids)
    this.pending = this.pending.filter((p) => !taken.has(p.mutation.mid))
    this.recompute()
    // What they held back can go now.
    if (this.unsent(1).length > 0) this.onMutation?.()
    return true
  }

  /**
   * Let held changes go now, whatever their timer says: written through, then pushed. What the
   * caller does once their Undo is gone. Any no longer held (let go, or taken back) are skipped.
   */
  release(...mids: string[]): void {
    this.letGo(mids)
  }

  /** Let every held change go now, in the order they were made: the page may not come back. */
  releaseHolds(): void {
    this.letGo([...this.holds.keys()])
  }

  /** Stop holding `mid`, and clear its timer once nothing else is held under it. */
  private unhold(mid: string): boolean {
    const hold = this.holds.get(mid)
    if (!hold) return false
    this.holds.delete(mid)
    hold.count -= 1
    if (hold.count === 0) this.timers.clear(hold.handle)
    return true
  }

  /** Stop holding `mids`, write them through in one write, and push. */
  private letGo(mids: readonly string[]): void {
    const going = new Set(mids.filter((mid) => this.unhold(mid)))
    const owner = this.userId
    if (going.size === 0 || owner === null) return
    const entries = this.pending.filter((p) => going.has(p.mutation.mid))
    if (entries.length === 0) return
    void this.write(owner, this.epoch, { put: entries })
    this.onMutation?.()
  }

  /**
   * Stop holding whatever `pending` no longer has, letting none of it go: it went with the
   * account, or a load replaced it. Every place that replaces `pending` calls this after.
   */
  private pruneHolds(): void {
    if (this.holds.size === 0) return
    const kept = new Set(this.pending.map((p) => p.mutation.mid))
    for (const mid of [...this.holds.keys()]) if (!kept.has(mid)) this.unhold(mid)
  }

  /**
   * Whether a privacy switch has to wait before it can be turned on (`privacyUnsettled`, issue
   * #16): a change this device made to it has not come back in a pull yet.
   */
  privacyUnsettled = (flag: PrivacyFlag): boolean =>
    privacyUnsettled(this.confirmed, this.pending, flag)

  /**
   * Turn a privacy switch on or off now. A show names the version in the confirmed rows, never
   * the view's, and one that has to wait changes nothing (`privacyChange`, issue #16).
   */
  setPrivacy(flag: PrivacyFlag, on: boolean): void {
    const change = privacyChange(this.confirmed, this.pending, flag, on)
    if (change) this.mutate(change)
  }

  /** Whether a blogroll has to wait before it can be made public (`blogrollPublicUnsettled`). */
  blogrollPublicUnsettled = (id: string): boolean =>
    blogrollPublicUnsettled(this.confirmed, this.pending, id)

  /**
   * Make a blogroll public or private now (ADR 0050). A show names the version in the confirmed
   * rows, and one that has to wait changes nothing, as a privacy switch's does.
   */
  setBlogrollPublic(id: string, on: boolean): void {
    const change = blogrollPublicChange(this.confirmed, this.pending, id, on)
    if (change) this.mutate(change)
  }

  /**
   * Fold in a pull asked for in `epoch`, unless the tab has stopped holding those rows since. Only
   * the tables it touched are rewritten, in one write with the cursor, which storage refuses
   * when it would move the stored cursor back over newer tables another tab of this account
   * wrote (`Change` in db.ts). Says whether to pull again from the start: a delta that sends a
   * table this copy has not held whole since its last snapshot (a tela-api back from a rollback
   * to before it, ADR 0048) is not folded in, since the rows of that table written meanwhile lie
   * behind the cursor, and only a snapshot brings them. The rows held stay on screen until it
   * comes.
   *
   * A delta that brings nothing (no row, no tombstone: what most of the minute's pulls bring)
   * still moves the cursor, which every other account's writes move too, and still settles the
   * changes it reaches, but it keeps the confirmed tables and, unless a change settled, the
   * snapshot: a new one re-renders every screen for nothing.
   */
  async applyPull(given: PullResponse, epoch: number): Promise<boolean> {
    const owner = this.userId
    if (owner === null || epoch !== this.epoch) return false
    const sent = new Set(Object.keys(given.rows))
    if (!given.reset && TABLES.some((t) => sent.has(t) && !this.covered.has(t))) {
      this.confirmed = { ...this.confirmed, cursor: 0 }
      return true
    }
    // What the copy holds whole from here: what this snapshot sent, or what the copy held and
    // this delta sent too.
    this.covered = new Set(
      TABLES.filter((t) => sent.has(t) && (given.reset || this.covered.has(t))),
    )
    // Titles in the language held only. A pull in another one (asked for before a switch) passed
    // that language's rows without bringing them: what is held is no longer whole, and the engine
    // fetches what is missing.
    const lang = this.titles.lang
    const { pull: titled, folded } =
      lang === null
        ? {
            pull: given,
            folded: (given as PullResponse & { titlesLang?: string }).titlesLang === undefined,
          }
        : titlesIn(given, lang)
    if (!folded) this.titlesRound++
    this.titles = { lang, whole: folded && (given.reset || this.titles.whole) }
    // Every table this build knows, so the loop below never reads one an older tela-api left out.
    const pull = completePull(titled)
    const before = this.confirmed.tables
    const from = this.confirmed.cursor
    const queued = this.pending
    const quiet =
      !pull.reset &&
      pull.tombstones.length === 0 &&
      Object.values(pull.rows).every((rows) => rows.length === 0)
    this.confirmed = quiet
      ? { cursor: pull.cursor, tables: before }
      : applyPull(this.confirmed, pull)
    const after = this.confirmed.tables.follows
    const changedFollows = quiet
      ? []
      : [
          ...[...after.values()].filter((f) => !before.follows.has(f.userId)),
          ...[...before.follows.values()].filter((f) => !after.has(f.userId)),
        ]
    if (changedFollows.length > 0) this.onFollowsConfirmed?.(changedFollows)
    // A held change is unanswered, so it stays, and nothing of it is written here.
    this.pending = settle(this.confirmed, this.pending)
    this.pruneHolds()
    if (!quiet || this.pending.length !== queued.length) this.recompute()
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
    // Titles a write of this tab's left out (`storeTitles`) go with this one.
    if (this.titlesDirty) changed.titles = rows.titles
    const carried = 'titles' in changed
    const written = await this.write(owner, epoch, {
      tables: changed,
      cursor: this.confirmed.cursor,
      from,
      whole: rows,
      covered: [...this.covered],
      titles: { ...this.titles, folded },
      drop: gone(queued, this.pending),
    })
    if (carried && epoch === this.epoch) this.titlesDirty = !written
    return false
  }

  /**
   * What to push next: mutations the server has not answered for, oldest first, up to the first
   * one still held. Nothing made after a held change goes before it (a subscribe made after a
   * mark-all-read must not reach the server first).
   */
  unsent(limit = 50): Mutation[] {
    const next: Mutation[] = []
    for (const p of this.pending) {
      if (next.length >= limit || this.holds.has(p.mutation.mid)) break
      if (p.ackedAt === undefined) next.push(p.mutation)
    }
    return next
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
    const queued = this.pending
    this.pending = this.pending
      .filter((p) => !refused.has(p.mutation.mid))
      .map((p) => (applied.has(p.mutation.mid) ? { ...p, ackedAt: res.seq } : p))
    this.pending = settle(this.confirmed, this.pending)
    this.pruneHolds()
    this.recompute()
    await this.write(owner, epoch, {
      put: this.pending.filter((p) => applied.has(p.mutation.mid)),
      drop: gone(queued, this.pending),
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

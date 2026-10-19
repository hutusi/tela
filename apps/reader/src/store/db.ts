/**
 * What the device keeps between visits, in IndexedDB (`idb`: a thin wrapper over the web
 * standard, chosen so there is almost nothing between Tela and the browser to age):
 *
 * - `meta`: whose rows these are (`owner`), the cursor and which tables the build that moved it
 *   keeps (`kept`), which language's titles it holds (`titles`), and the pending mutations, one
 *   record each (`pending:<mid>`, tagged with the owner that queued it). Tabs share this database, and
 *   each holds only its own pending list in memory: one record for the whole list let a tab's
 *   save erase another tab's unsent changes.
 * - `tables`: one record per synced table (a few thousand rows at most; written whole).
 * - `bodies`: content objects by content key, with when each was last opened, for eviction.
 * - `objects`: translation and chunk objects by their R2 key. Immutable, like bodies, and evicted
 *   with the body they translate.
 *
 * One copy, one owner. Tabs share the copy, and a tab may still hold an account another tab has
 * signed out of, so no write of a member's rows trusts what its tab remembers: each is one
 * readwrite transaction that reads `owner` first and writes nothing unless it is the writer's.
 * IndexedDB runs readwrite transactions whose scopes overlap one at a time, across every
 * connection, so no other tab can come between the check and the write. Between them nothing but
 * IndexedDB requests is awaited: a transaction left idle commits, and the check with it.
 *
 * Bodies and objects are public and content-addressed, the same for every account, so writing
 * them checks nothing; a change of owner clears them with everything else.
 *
 * This layout has a database of its own (`DATABASE`), never the name earlier builds used. A
 * cached earlier shell still open in another tab, or one a rollback brings back, writes its own
 * copy without checking any owner; sharing one database let it write its rows into a copy this
 * build had given to another account, and let this build erase the key that earlier build checks.
 * What that build does is still seen: `earlierBuild` looks at its copy at each boot, and finding
 * it written again means this build's copy may not know of a sign-out or a sign-in since.
 *
 * Everything here can be rebuilt from the server, so a browser that clears it loses nothing.
 */
import type { Pending, TableRows } from '@tela/sync'
import {
  type DBSchema,
  type IDBPDatabase,
  type IDBPTransaction,
  openDB,
  type StoreNames,
} from 'idb'
import { newId } from '../lib/id'

export type StoredBody = { key: string; object: unknown; bytes: number; lastOpened: number }
export type StoredObject = { key: string; object: unknown; at: number }

interface TelaDB extends DBSchema {
  meta: { key: string; value: unknown }
  tables: { key: keyof TableRows; value: unknown }
  bodies: { key: string; value: StoredBody; indexes: { lastOpened: number } }
  objects: { key: string; value: StoredObject }
}

export type Persisted = {
  /** Whose rows these are. Null means nobody's, and then nothing is stored. */
  owner: string | null
  /**
   * The mark an earlier build having run on this device leaves (`distrust`), or null: a sign-out
   * or sign-in there never reached the copy, so no tab trusts it until a claim after /me. Each
   * mark is new, so a claim can tell the one that stood when its /me was asked from one set
   * since.
   */
  unverified: string | null
  cursor: number
  rows: TableRows | null
  /**
   * The tables the copy holds whole up to `cursor` (`KEPT`): those the server sent since the copy
   * was last a snapshot. One a tela-api from before it left out is not among them, though the
   * copy holds it (empty, or as it was); when the server sends it again, only a snapshot can
   * bring its rows back. Empty with no rows.
   */
  covered: string[]
  /** Which language's titles the copy holds, and whether whole up to `cursor` (`TitlesHeld`). */
  titles: TitlesHeld
  pending: Pending[]
}

/**
 * Which language's titles a copy holds, and whether it holds them whole up to its cursor: every
 * title the server has in that language for the articles held. `lang` null is every language a
 * pull sent, as a copy from a build before the device kept one language holds them, or a copy
 * holds them while it does not know its language yet. The device keeps titles in its reading
 * language only, and fetches what it lacks of them (`SyncEngine`) until they are whole.
 */
export type TitlesHeld = { lang: string | null; whole: boolean }

/** The titles of a copy that holds nothing to trust: every language, none of it whole. */
const NO_TITLES: TitlesHeld = { lang: null, whole: false }

/**
 * One write of an owner's rows: whatever it names lands together, or none of it does. A pull's
 * tables and cursor are written only when the pull covers everything after the stored cursor
 * (`from` at or below it) and moves it forward: then the tables it did not touch are as current
 * as the ones it did. Another tab of the same account may have stored a newer copy, or one a
 * snapshot set back; a write that fits neither is left out (its pending records still land), and
 * the stored copy stays consistent at its own cursor. A snapshot writes every table and may lower
 * the cursor, after a restore from a backup.
 */
export type Change = {
  tables?: Partial<TableRows>
  cursor?: number
  /** The cursor the pull these tables come from started at. */
  from?: number
  /**
   * Every table as the writer holds it, consistent at `cursor`: written instead of `tables` when
   * the stored copy is behind where this pull started (another tab's late snapshot set it back),
   * so a tab ahead of the copy keeps it current rather than waiting for that tab to pull again.
   */
  whole?: TableRows
  /**
   * The tables the writer's copy holds whole up to `cursor` (`Persisted.covered`). A write that
   * moves the cursor without it covers none: the copy is not trusted until a snapshot.
   */
  covered?: readonly string[]
  /**
   * The writer's titles (`TitlesHeld`), and whether the pull from `from` to `cursor` brought
   * their language (`folded`; a write that does not move the cursor brought nothing to miss).
   * What the stored copy then says of its titles (`titlesAfter`). A write that moves the cursor
   * without it leaves that record where it was, which then reads as stale: what an earlier
   * build's write does.
   */
  titles?: TitlesHeld & { folded: boolean }
  /**
   * Told, as the write is made, whether its tables and cursor were written or left out (`fits`):
   * a writer whose titles were left out writes them again with its next pull.
   */
  placed?: (written: boolean) => void
  /** Unsent changes to record, one record each, so no tab writes over another's. */
  put?: readonly Pending[]
  /** Changes to forget: answered and caught up with, or refused. */
  drop?: readonly string[]
}

/** What the store needs from storage; IndexedDB in the browser, memory in tests. */
export interface Persistence {
  /**
   * The copy and its owner, and only the pending changes that owner queued. A copy with no owner
   * (every earlier build's, which recorded `userId` instead) is nobody's to trust: it is wiped.
   */
  load(): Promise<Persisted>
  /**
   * Make the copy `owner`'s. Anyone else's, or nobody's, is wiped first; says whether it was.
   * It clears the mark if it is still `seen`, the one that stood when the claim's /me was asked.
   * A mark set since stays: /me may have answered before whatever set it.
   */
  claim(owner: string, seen?: string | null): Promise<boolean>
  /**
   * Mark the copy unverified, whoever owns it or if nobody does (`Persisted.unverified`). Only a
   * claim clears the mark; wiping the copy keeps it.
   */
  distrust(): Promise<void>
  /** The mark as it stands, or null. */
  mark(): Promise<string | null>
  /** Wipe the copy while it is still `owner`'s; another account's is left alone. Says which. */
  release(owner: string): Promise<boolean>
  /**
   * Write `change` if the copy is still `owner`'s. False, having written nothing, when it is not;
   * an IndexedDB failure (a full disk, an abort) rejects instead, so it never looks like one.
   */
  commit(owner: string, change: Change): Promise<boolean>
  getBody(key: string): Promise<StoredBody | undefined>
  putBody(body: StoredBody): Promise<void>
  touchBody(key: string, at: number): Promise<void>
  getObject(key: string): Promise<StoredObject | undefined>
  putObject(object: StoredObject): Promise<void>
  /**
   * Evict: drop the bodies last opened at or before `before`, then the oldest of the rest until
   * they come to `capBytes` at most, and every translation and chunk object of a body no longer
   * held. Says which bodies went.
   */
  evictBodies(before: number, capBytes: number): Promise<string[]>
  /** Every body held, by key: what prefetch need not fetch again. */
  bodyKeys(): Promise<string[]>
}

/**
 * Every table the device holds. One missing from storage means it was written by a build that
 * did not know it, so the device starts over from a snapshot rather than trust a cursor that has
 * passed rows it never kept (highlights, added after the first devices synced; follows, ADR 0031;
 * folders, ADR 0048; blogrolls, ADR 0050). Present is not enough: see `KEPT`.
 */
export const TABLES: (keyof TableRows)[] = [
  'profile',
  'prefs',
  'subscriptions',
  'feeds',
  'sites',
  'articles',
  'titles',
  'states',
  'recommendations',
  'highlights',
  'claims',
  'translations',
  'follows',
  'folders',
  'feedFolders',
  'blogrolls',
  'blogrollBlogs',
]

/** This layout's database. Earlier builds used 'tela', with no owner and no checks. */
export const DATABASE = 'tela-2'
const EARLIER = 'tela'

/** Left in the earlier build's emptied copy, where that build never reads; its clear() takes it. */
const SEEN = 'tela-2:seen'

/** What an earlier build does on this device, as each boot finds it (`openStore`). */
export type EarlierBuild = {
  /**
   * Whether it has touched its copy since this build last saw it: written, or cleared (its
   * sign-out, which takes the seen mark with everything else). It ran on this device since (a
   * tab left open across the deploy, or a rollback), and a sign-out or another account's sign-in
   * there never reached this build's copy. A copy another tab of this build is still emptying
   * counts as touched too. Only looks.
   */
  wrote(): Promise<boolean>
  /**
   * Empty its copy if it was touched, looked at again in the same transaction, and leave it
   * being emptied, which still reads as touched; says by which token, or null when there was
   * nothing to empty. Emptied, not deleted: a deletion waits for every tab of that build to
   * close, and one of them reloading meanwhile would wait behind it on a blank page.
   */
  empty(): Promise<string | null>
  /**
   * Mark it seen, once this tab's copy is marked unverified again: only if it still holds
   * `token`. A sign-out since took the token with everything else, and anything written since is
   * still there to be seen, so either stays touched for the next look.
   */
  seen(token: string): Promise<void>
}

/** Whether the earlier build's copy says it ran, or is being emptied, since it was last seen. */
function touched(seen: unknown, keys: IDBValidKey[], counts: number[]): boolean {
  return seen !== true || keys.length > 1 || counts.some((n) => n > 0)
}

/**
 * Run `body` over the earlier build's database, if there is one with a `meta` store; `none` when
 * there is none, or IndexedDB refuses: then nothing an earlier build left can be read here either.
 */
async function withEarlier<T>(
  none: T,
  body: (db: IDBPDatabase, names: string[]) => Promise<T>,
): Promise<T> {
  try {
    // Opening a name that does not exist would create it: only one that is listed is opened.
    const listed = await indexedDB.databases?.()
    if (!listed?.some((d) => d.name === EARLIER)) return none
    const db = await openDB(EARLIER)
    try {
      const names = Array.from(db.objectStoreNames)
      return names.includes('meta') ? await body(db, names) : none
    } finally {
      db.close()
    }
  } catch {
    return none
  }
}

/** The seen mark, `meta`'s keys, and every other store's count, in `tx`. */
function contents<Mode extends IDBTransactionMode>(
  tx: IDBPTransaction<unknown, string[], Mode>,
  names: string[],
) {
  return Promise.all([
    tx.objectStore('meta').get(SEEN),
    tx.objectStore('meta').getAllKeys(),
    Promise.all(names.filter((n) => n !== 'meta').map((n) => tx.objectStore(n).count())),
  ])
}

export const earlierBuild: EarlierBuild = {
  wrote: () =>
    withEarlier(false, async (db, names) => {
      const tx = db.transaction(names, 'readonly')
      const [[seen, keys, counts]] = await Promise.all([contents(tx, names), tx.done])
      return touched(seen, keys, counts)
    }),
  empty: () =>
    withEarlier<string | null>(null, async (db, names) => {
      const tx = db.transaction(names, 'readwrite')
      const [seen, keys, counts] = await contents(tx, names)
      if (!touched(seen, keys, counts)) {
        await tx.done
        return null
      }
      const token = `emptying:${newId()}`
      await Promise.all(names.map((n) => tx.objectStore(n).clear()))
      await tx.objectStore('meta').put(token, SEEN)
      await tx.done
      return token
    }),
  seen: (token) =>
    withEarlier(undefined, async (db) => {
      const tx = db.transaction('meta', 'readwrite')
      if ((await tx.store.get(SEEN)) === token) await tx.store.put(true, SEEN)
      await tx.done
    }),
}

const OWNER = 'owner'
const CURSOR = 'cursor'
/**
 * Where the cursor was last moved by a build that writes this, and which tables the copy holds
 * whole up to it: every table the server sent since the copy was last a snapshot. Every move of
 * the cursor here writes it. Two writers leave it behind, and either makes the copy untrustworthy
 * in a way that a table being present cannot show (ADR 0048):
 *
 * - A build from before a table (a tab left open across the deploy, sharing this database) moves
 *   the cursor past that table's rows, dropping them. The table is there, written here earlier,
 *   but stale, and its rows never come again: a folder deleted elsewhere would stay for good. Its
 *   move leaves `cursor` behind, and the copy starts over at the next load.
 * - A tela-api from before a table (a rollback) sends no rows of it, and the device keeps it empty
 *   or as it was. The table is left out of `tables`. The copy loads as it is, and starts over when
 *   the server sends that table again (`LocalStore.applyPull`), so a boot during the rollback does
 *   not wait on the network each time.
 */
const KEPT = 'kept'
type Kept = { tables: string[]; cursor: number }

/** What the copy holds whole up to its cursor, if a build that writes `KEPT` moved it last. */
function keptAt(kept: unknown, cursor: number): string[] | null {
  if (typeof kept !== 'object' || kept === null) return null
  const k = kept as Partial<Kept>
  if (k.cursor !== cursor || !Array.isArray(k.tables)) return null
  return k.tables.filter((t): t is string => typeof t === 'string')
}

/**
 * `KEPT` after a write of `rows` at `cursor` over a copy that held `stored` whole (null: not
 * trusted). A table the write puts is the writer's whole copy of it, so it is whole if the writer
 * holds it whole; one it leaves is whole if it was and the writer holds it whole too, since the
 * writer's pull covered everything after the stored cursor. A write of every table is the
 * writer's whole copy.
 */
export function keptAfter(
  stored: readonly string[] | null,
  rows: Partial<TableRows>,
  covered: readonly string[],
  cursor: number,
): Kept {
  const writes = new Set<string>(Object.keys(rows))
  const all = TABLES.every((t) => writes.has(t))
  const was = new Set(stored ?? [])
  return { tables: covered.filter((t) => all || writes.has(t) || was.has(t)), cursor }
}

/**
 * Which language's titles the copy holds, and where the cursor was when that was last said
 * (`TitlesHeld`). A record of its own beside `KEPT`, never a table in it: `KEPT` says the titles
 * table is whole, which a pull in another language makes untrue while the table is still sent,
 * so whether a language is whole can only be said in a record stamped with the cursor it was true
 * at. Without the stamp, a tab still on the old language (sharing this database) moves the cursor
 * past the new language's rows, and the copy would claim them. Nor inside the titles table's own
 * record: earlier builds read that as an array of rows.
 */
const TITLES = 'titles'
type TitlesRecord = TitlesHeld & { cursor: number }

/**
 * The copy's titles as its record says them at `cursor`: whole only if the record was written
 * there. No record at all is a copy from before this build, which pulled every language: every
 * language, whole as far as `KEPT` says, so only a caller that trusts `KEPT` asks. Null when the
 * record cannot be read.
 */
function titlesAt(record: unknown, cursor: number): TitlesHeld | null {
  if (record === undefined) return { lang: null, whole: true }
  if (typeof record !== 'object' || record === null) return null
  const r = record as Partial<TitlesRecord>
  if (typeof r.whole !== 'boolean' || typeof r.cursor !== 'number') return null
  if (r.lang !== null && typeof r.lang !== 'string') return null
  return { lang: r.lang, whole: r.whole && r.cursor === cursor }
}

/**
 * The titles record after a write of `rows` at `cursor` over a copy whose titles were `stored`
 * (null: nothing to trust). A write that puts the titles table puts the writer's whole copy of
 * it, so the writer's record goes with it. One that leaves the table moves the cursor past
 * whatever the server wrote meanwhile: the stored titles stay whole only if they were, and the
 * pull brought their language (`folded`, and the same language, or every language, on either
 * side); otherwise
 * they are what they were and no longer whole, until a write puts them whole again.
 */
export function titlesAfter(
  stored: TitlesHeld | null,
  rows: Partial<TableRows>,
  writer: TitlesHeld & { folded: boolean },
  cursor: number,
): TitlesRecord {
  if ('titles' in rows) return { lang: writer.lang, whole: writer.whole, cursor }
  if (stored === null) return { lang: writer.lang, whole: false, cursor }
  // A copy holding every language (one from before ADR 0052) holds the writer's whole too.
  const brought =
    writer.folded && (writer.lang === null || stored.lang === null || writer.lang === stored.lang)
  return { lang: stored.lang ?? writer.lang, whole: brought && stored.whole, cursor }
}
const UNVERIFIED = 'unverified'
/** Earlier builds' keys: the owner, and the whole pending list in one record. Never read. */
const LEGACY = ['userId', 'pending']
const PENDING = 'pending:'
const pendingKey = (mid: string) => `${PENDING}${mid}`
const pendingRange = () => IDBKeyRange.bound(PENDING, `${PENDING}\uffff`)

/** A pending change as stored: tagged with the account that queued it. */
type StoredPending = Pending & { owner: string }

/** Oldest first, as they were made; `mid` only orders two made in the same millisecond. */
function inOrder(entries: Iterable<Pending>): Pending[] {
  const byMid = new Map<string, Pending>()
  for (const e of entries) byMid.set(e.mutation.mid, e)
  return [...byMid.values()].sort(
    (a, b) => a.mutation.at - b.mutation.at || a.mutation.mid.localeCompare(b.mutation.mid),
  )
}

/** Whether writing `change`'s tables and cursor over a copy at `stored` keeps it consistent. */
function fits(change: Change, stored: number): boolean {
  const tables = change.tables ?? {}
  // A snapshot: every table, consistent whatever was stored.
  if (TABLES.every((t) => t in tables)) return true
  // No cursor to place, so no tables either (a change of pending records only).
  if (change.cursor === undefined) return Object.keys(tables).length === 0
  // Some tables, or none, at a new cursor: only a pull that says where it started can show it
  // covers everything after the stored cursor.
  return change.from !== undefined && change.from <= stored && stored <= change.cursor
}

/** The tables to write for `change` over a copy at `stored`, or null to leave them out. */
function placed(change: Change, stored: number): Partial<TableRows> | null {
  if (fits(change, stored)) return change.tables ?? {}
  // Ahead of the copy: the writer's whole copy is a snapshot at its cursor, which always fits.
  if (change.whole && change.cursor !== undefined && change.cursor >= stored) return change.whole
  return null
}

/** The content key a translation (`t/<key>/…`) or chunk (`tc/<key>/…`) object belongs to. */
function bodyOf(objectKey: string): string | null {
  return /^tc?\/([^/]+)\//.exec(objectKey)?.[1] ?? null
}

/**
 * Which bodies eviction drops, from `newestFirst`: those past the cap once every newer one is
 * counted (the stale ones the caller found by key are not among them).
 */
function pastCap(newestFirst: Iterable<{ key: string; bytes: number }>, capBytes: number) {
  const drop: string[] = []
  let bytes = 0
  for (const body of newestFirst) {
    bytes += body.bytes
    if (bytes > capBytes) drop.push(body.key)
  }
  return drop
}

/** The content keys of the objects whose body is not among `kept`. */
function orphans(objectKeys: Iterable<string>, kept: ReadonlySet<string>): Set<string> {
  const out = new Set<string>()
  for (const key of objectKeys) {
    const body = bodyOf(key)
    if (body !== null && !kept.has(body)) out.add(body)
  }
  return out
}

const STORES = ['meta', 'tables', 'bodies', 'objects'] as const
type Store = StoreNames<TelaDB>
type Tx = IDBPTransaction<TelaDB, Store[], 'readwrite'>

export async function indexedDbPersistence(name = DATABASE): Promise<Persistence> {
  const db: IDBPDatabase<TelaDB> = await openDB<TelaDB>(name, 1, {
    upgrade(d) {
      d.createObjectStore('meta')
      d.createObjectStore('tables')
      d.createObjectStore('bodies', { keyPath: 'key' }).createIndex('lastOpened', 'lastOpened')
      d.createObjectStore('objects', { keyPath: 'key' })
    },
  })

  /**
   * One readwrite transaction over `scope`, settled once it has committed. `body` may await only
   * the transaction's own requests.
   */
  async function write<T>(scope: readonly Store[], body: (tx: Tx) => Promise<T>): Promise<T> {
    const tx = db.transaction([...scope], 'readwrite')
    const [result] = await Promise.all([body(tx), tx.done])
    return result
  }

  const ownerOf = async (tx: Tx) =>
    ((await tx.objectStore('meta').get(OWNER)) as string | undefined) ?? null

  const markOf = async (tx: Tx) => {
    const mark = await tx.objectStore('meta').get(UNVERIFIED)
    return typeof mark === 'string' ? mark : null
  }

  /** Everything goes but the mark, which only a claim clears (`distrust`). */
  const wipe = async (tx: Tx) => {
    const mark = await markOf(tx)
    await Promise.all(STORES.map((s) => tx.objectStore(s).clear()))
    if (mark !== null) await tx.objectStore('meta').put(mark, UNVERIFIED)
  }

  return {
    load: () =>
      write(STORES, async (tx) => {
        const owner = await ownerOf(tx)
        if (owner === null) {
          await wipe(tx)
          return {
            owner: null,
            unverified: await markOf(tx),
            cursor: 0,
            rows: null,
            covered: [],
            titles: NO_TITLES,
            pending: [],
          }
        }
        const meta = tx.objectStore('meta')
        const [cursor, kept, titles, unverified, keys, records, values] = await Promise.all([
          meta.get(CURSOR),
          meta.get(KEPT),
          meta.get(TITLES),
          markOf(tx),
          meta.getAllKeys(pendingRange()),
          meta.getAll(pendingRange()) as Promise<StoredPending[]>,
          Promise.all(TABLES.map((t) => tx.objectStore('tables').get(t))),
        ])
        // Changes queued for anyone else (or no one) are not this owner's to send.
        const pending: Pending[] = []
        const stray: Promise<void>[] = LEGACY.map((k) => meta.delete(k))
        records.forEach((record, i) => {
          const key = keys[i]
          if (record.owner === owner) pending.push(untag(record))
          else if (key !== undefined) stray.push(meta.delete(key))
        })
        await Promise.all(stray)
        const at = Number(cursor ?? 0)
        const covered = keptAt(kept, at)
        const complete = values.every((v) => v !== undefined) && covered !== null
        return {
          owner,
          unverified,
          cursor: complete ? at : 0,
          rows: complete
            ? (Object.fromEntries(TABLES.map((t, i) => [t, values[i]])) as TableRows)
            : null,
          covered: complete ? (covered ?? []) : [],
          titles: complete ? (titlesAt(titles, at) ?? NO_TITLES) : NO_TITLES,
          pending: inOrder(pending),
        }
      }),
    claim: (owner, seen = null) =>
      write(STORES, async (tx) => {
        const [stored, mark] = await Promise.all([ownerOf(tx), markOf(tx)])
        const wiped = stored !== owner
        if (wiped) {
          await wipe(tx)
          await tx.objectStore('meta').put(owner, OWNER)
        }
        if (mark !== null && mark === seen) await tx.objectStore('meta').delete(UNVERIFIED)
        return wiped
      }),
    distrust: () =>
      write(['meta'], async (tx) => {
        await tx.objectStore('meta').put(newId(), UNVERIFIED)
      }),
    async mark() {
      const mark = await db.get('meta', UNVERIFIED)
      return typeof mark === 'string' ? mark : null
    },
    release: (owner) =>
      write(STORES, async (tx) => {
        // Nothing of `owner`'s is in a copy that is someone else's: the claim that made it
        // theirs wiped it, and every write since checked the owner.
        if ((await ownerOf(tx)) !== owner) return false
        await wipe(tx)
        return true
      }),
    commit: (owner, change) =>
      write(['meta', 'tables'], async (tx) => {
        const meta = tx.objectStore('meta')
        const [stored, storedCursor, storedKept, storedTitles] = await Promise.all([
          ownerOf(tx),
          meta.get(CURSOR),
          meta.get(KEPT),
          meta.get(TITLES),
        ])
        if (stored !== owner) return false
        const tables = tx.objectStore('tables')
        const at = Number(storedCursor ?? 0)
        const rows = placed(change, at)
        const was = keptAt(storedKept, at)
        const kept =
          rows && change.cursor !== undefined
            ? keptAfter(was, rows, change.covered ?? [], change.cursor)
            : null
        // A copy whose `KEPT` is not trusted holds no titles worth keeping either.
        const before = was === null ? null : titlesAt(storedTitles, at)
        const titles =
          rows && kept && change.titles
            ? titlesAfter(before, rows, change.titles, kept.cursor)
            : null
        change.placed?.(rows !== null)
        await Promise.all([
          ...Object.entries(rows ?? {}).map(([t, value]) =>
            tables.put(value, t as keyof TableRows),
          ),
          ...(kept ? [meta.put(kept.cursor, CURSOR), meta.put(kept, KEPT)] : []),
          ...(titles ? [meta.put(titles, TITLES)] : []),
          ...(change.put ?? []).map((e) =>
            meta.put({ ...e, owner } satisfies StoredPending, pendingKey(e.mutation.mid)),
          ),
          ...(change.drop ?? []).map((mid) => meta.delete(pendingKey(mid))),
        ])
        return true
      }),
    getBody: (key) => db.get('bodies', key),
    async putBody(body) {
      await db.put('bodies', body)
    },
    async touchBody(key, at) {
      const tx = db.transaction('bodies', 'readwrite')
      const body = await tx.store.get(key)
      if (body) await tx.store.put({ ...body, lastOpened: at })
      await tx.done
    },
    getObject: (key) => db.get('objects', key),
    async putObject(object) {
      await db.put('objects', object)
    },
    async evictBodies(before, capBytes) {
      // Planned in a read-only transaction, so an open is not held up while bodies are counted.
      // The stale ones are found by key on the index, never read: a week of prefetched bodies
      // nobody opened is most of what goes. Only the rest are read, newest first, for their size.
      const plan = db.transaction(['bodies', 'objects'])
      const index = plan.objectStore('bodies').index('lastOpened')
      const stale = await index.getAllKeys(IDBKeyRange.upperBound(before))
      const fresh: { key: string; bytes: number }[] = []
      let cursor = await index.openCursor(IDBKeyRange.lowerBound(before, true), 'prev')
      while (cursor) {
        fresh.push({ key: cursor.primaryKey, bytes: cursor.value.bytes })
        cursor = await cursor.continue()
      }
      const objectKeys = await plan.objectStore('objects').getAllKeys()
      await plan.done
      const drop = [...stale, ...pastCap(fresh, capBytes)]
      const gone = new Set(drop)
      const orphaned = orphans(
        objectKeys,
        new Set(fresh.map((b) => b.key).filter((k) => !gone.has(k))),
      )
      if (drop.length === 0 && orphaned.size === 0) return []
      // Each body's translations and chunks go by key range: a streamed one is many objects.
      const tx = db.transaction(['bodies', 'objects'], 'readwrite')
      const objects = tx.objectStore('objects')
      await Promise.all([
        ...drop.map((key) => tx.objectStore('bodies').delete(key)),
        ...[...orphaned].flatMap((key) => [
          objects.delete(IDBKeyRange.bound(`t/${key}/`, `t/${key}/\uffff`)),
          objects.delete(IDBKeyRange.bound(`tc/${key}/`, `tc/${key}/\uffff`)),
        ]),
        tx.done,
      ])
      return drop
    },
    bodyKeys: () => db.getAllKeys('bodies'),
  }
}

/** A stored pending record as the store holds it: without the tag. */
function untag(record: StoredPending): Pending {
  const { mutation, ackedAt } = record
  return ackedAt === undefined ? { mutation } : { mutation, ackedAt }
}

/** Storage that forgets everything: tests, and browsers that refuse IndexedDB. */
export function memoryPersistence(): Persistence {
  let owner: string | null = null
  let unverified: string | null = null
  let cursor = 0
  let tables: Partial<TableRows> = {}
  // What `tables` holds whole up to `cursor`, as `KEPT` says it in IndexedDB.
  let covered: string[] = []
  // Which language's titles, as `TITLES` says it in IndexedDB: none until a write names them.
  let titles: TitlesRecord | undefined
  // Only the owner's: a claim wipes them with everything else, and every write checks.
  const pending = new Map<string, Pending>()
  const bodies = new Map<string, StoredBody>()
  const objects = new Map<string, StoredObject>()
  // Everything but the mark, as in IndexedDB.
  const wipe = () => {
    cursor = 0
    tables = {}
    covered = []
    titles = undefined
    pending.clear()
    bodies.clear()
    objects.clear()
  }
  const complete = () => TABLES.every((t) => t in tables)
  return {
    async load() {
      if (owner === null) {
        wipe()
        return {
          owner: null,
          unverified,
          cursor: 0,
          rows: null,
          covered: [],
          titles: NO_TITLES,
          pending: [],
        }
      }
      const whole = complete()
      return {
        owner,
        unverified,
        cursor: whole ? cursor : 0,
        rows: whole ? (tables as TableRows) : null,
        covered: whole ? covered : [],
        titles: whole ? (titlesAt(titles, cursor) ?? NO_TITLES) : NO_TITLES,
        pending: inOrder(pending.values()),
      }
    },
    async claim(o, seen = null) {
      const wiped = owner !== o
      if (wiped) {
        wipe()
        owner = o
      }
      if (unverified !== null && unverified === seen) unverified = null
      return wiped
    },
    async distrust() {
      unverified = newId()
    },
    mark: async () => unverified,
    async release(o) {
      if (owner !== o) return false
      wipe()
      owner = null
      return true
    },
    async commit(o, change) {
      if (owner !== o) return false
      const rows = placed(change, cursor)
      if (rows && change.cursor !== undefined && change.titles) {
        // Before the tables change: what the copy held at its cursor, if it held anything.
        const before = complete() ? titlesAt(titles, cursor) : null
        titles = titlesAfter(before, rows, change.titles, change.cursor)
      }
      change.placed?.(rows !== null)
      if (rows) {
        tables = { ...tables, ...rows }
        if (change.cursor !== undefined) {
          covered = keptAfter(covered, rows, change.covered ?? [], change.cursor).tables
          cursor = change.cursor
        }
      }
      for (const e of change.put ?? []) pending.set(e.mutation.mid, e)
      for (const mid of change.drop ?? []) pending.delete(mid)
      return true
    },
    getBody: async (key) => bodies.get(key),
    putBody: async (b) => void bodies.set(b.key, b),
    touchBody: async (key, at) => {
      const b = bodies.get(key)
      if (b) bodies.set(key, { ...b, lastOpened: at })
    },
    getObject: async (key) => objects.get(key),
    putObject: async (o) => void objects.set(o.key, o),
    async evictBodies(before, capBytes) {
      const all = [...bodies.values()]
      const stale = all.filter((b) => b.lastOpened <= before).map((b) => b.key)
      const newestFirst = all
        .filter((b) => b.lastOpened > before)
        .sort((a, b) => b.lastOpened - a.lastOpened || (a.key < b.key ? 1 : -1))
      const drop = [...stale, ...pastCap(newestFirst, capBytes)]
      for (const key of drop) bodies.delete(key)
      const orphaned = orphans(objects.keys(), new Set(bodies.keys()))
      for (const key of [...objects.keys()]) {
        const body = bodyOf(key)
        if (body !== null && orphaned.has(body)) objects.delete(key)
      }
      return drop
    },
    bodyKeys: async () => [...bodies.keys()],
  }
}

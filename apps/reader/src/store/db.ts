/**
 * What the device keeps between visits, in IndexedDB (`idb`: a thin wrapper over the web
 * standard, chosen so there is almost nothing between Tela and the browser to age):
 *
 * - `meta`: whose rows these are (`owner`), the cursor, and the pending mutations, one record
 *   each (`pending:<mid>`, tagged with the owner that queued it). Tabs share this database, and
 *   each holds only its own pending list in memory: one record for the whole list let a tab's
 *   save erase another tab's unsent changes.
 * - `tables`: one record per synced table (a few thousand rows at most; written whole).
 * - `bodies`: content objects by content key, with when each was last opened, for eviction.
 * - `objects`: translation and chunk objects by their R2 key. Immutable, like bodies.
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
  pending: Pending[]
}

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
  /** Bodies opened before `before`, oldest first, for eviction. */
  staleBodies(before: number): Promise<StoredBody[]>
  deleteBodies(keys: string[]): Promise<void>
  bodyBytes(): Promise<number>
  /** Every body held, by key: what prefetch need not fetch again. */
  bodyKeys(): Promise<string[]>
}

/**
 * Every table the device holds. One missing from storage means it was written by a build that
 * did not know it, so the device starts over from a snapshot rather than trust a cursor that has
 * passed rows it never kept (highlights, added after the first devices synced).
 */
const TABLES: (keyof TableRows)[] = [
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
          return { owner: null, unverified: await markOf(tx), cursor: 0, rows: null, pending: [] }
        }
        const meta = tx.objectStore('meta')
        const [cursor, unverified, keys, records, values] = await Promise.all([
          meta.get(CURSOR),
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
        const complete = values.every((v) => v !== undefined)
        return {
          owner,
          unverified,
          cursor: complete ? Number(cursor ?? 0) : 0,
          rows: complete
            ? (Object.fromEntries(TABLES.map((t, i) => [t, values[i]])) as TableRows)
            : null,
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
        const [stored, storedCursor] = await Promise.all([ownerOf(tx), meta.get(CURSOR)])
        if (stored !== owner) return false
        const tables = tx.objectStore('tables')
        const rows = placed(change, Number(storedCursor ?? 0))
        await Promise.all([
          ...Object.entries(rows ?? {}).map(([t, value]) =>
            tables.put(value, t as keyof TableRows),
          ),
          ...(rows && change.cursor !== undefined ? [meta.put(change.cursor, CURSOR)] : []),
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
    async staleBodies(before) {
      return db.getAllFromIndex('bodies', 'lastOpened', IDBKeyRange.upperBound(before))
    },
    async deleteBodies(keys) {
      const tx = db.transaction('bodies', 'readwrite')
      for (const k of keys) await tx.store.delete(k)
      await tx.done
    },
    bodyKeys: () => db.getAllKeys('bodies'),
    async bodyBytes() {
      let total = 0
      let cursor = await db.transaction('bodies').store.openCursor()
      while (cursor) {
        total += cursor.value.bytes
        cursor = await cursor.continue()
      }
      return total
    },
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
  // Only the owner's: a claim wipes them with everything else, and every write checks.
  const pending = new Map<string, Pending>()
  const bodies = new Map<string, StoredBody>()
  const objects = new Map<string, StoredObject>()
  // Everything but the mark, as in IndexedDB.
  const wipe = () => {
    cursor = 0
    tables = {}
    pending.clear()
    bodies.clear()
    objects.clear()
  }
  return {
    async load() {
      if (owner === null) {
        wipe()
        return { owner: null, unverified, cursor: 0, rows: null, pending: [] }
      }
      const complete = TABLES.every((t) => t in tables)
      return {
        owner,
        unverified,
        cursor: complete ? cursor : 0,
        rows: complete ? (tables as TableRows) : null,
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
      if (rows) {
        tables = { ...tables, ...rows }
        if (change.cursor !== undefined) cursor = change.cursor
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
    staleBodies: async (before) =>
      [...bodies.values()]
        .filter((b) => b.lastOpened <= before)
        .sort((a, b) => a.lastOpened - b.lastOpened),
    deleteBodies: async (keys) => {
      for (const k of keys) bodies.delete(k)
    },
    bodyBytes: async () => [...bodies.values()].reduce((n, b) => n + b.bytes, 0),
    bodyKeys: async () => [...bodies.keys()],
  }
}

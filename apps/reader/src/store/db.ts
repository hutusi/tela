/**
 * What the device keeps between visits, in IndexedDB (`idb`: a thin wrapper over the web
 * standard, chosen so there is almost nothing between Tela and the browser to age):
 *
 * - `meta`: the cursor, who the rows belong to, and the pending mutations, one record each
 *   (`pending:<mid>`). Tabs share this database, and each holds only its own pending list in
 *   memory: one record for the whole list let a tab's save erase another tab's unsent changes.
 * - `tables`: one record per synced table (a few thousand rows at most; written whole).
 * - `bodies`: content objects by content key, with when each was last opened, for eviction.
 * - `objects`: translation and chunk objects by their R2 key. Immutable, like bodies.
 *
 * Everything here can be rebuilt from the server, so a browser that clears it loses nothing.
 */
import type { Pending, TableRows } from '@tela/sync'
import { type DBSchema, type IDBPDatabase, openDB } from 'idb'

export type StoredBody = { key: string; object: unknown; bytes: number; lastOpened: number }
export type StoredObject = { key: string; object: unknown; at: number }

interface TelaDB extends DBSchema {
  meta: { key: string; value: unknown }
  tables: { key: keyof TableRows; value: unknown }
  bodies: { key: string; value: StoredBody; indexes: { lastOpened: number } }
  objects: { key: string; value: StoredObject }
}

export type Persisted = {
  userId: string | null
  cursor: number
  rows: TableRows | null
  pending: Pending[]
}

/** What the store needs from storage; IndexedDB in the browser, memory in tests. */
export interface Persistence {
  load(): Promise<Persisted>
  /** Whose rows are stored now: another tab may have signed in as someone else since `load`. */
  storedUserId(): Promise<string | null>
  saveTables(rows: Partial<TableRows>): Promise<void>
  saveMeta(meta: { cursor?: number; userId?: string | null }): Promise<void>
  /** Record these unsent changes, one record each, so no tab writes over another's. */
  savePending(entries: readonly Pending[]): Promise<void>
  /** Forget these changes: answered and caught up with, or refused. */
  dropPending(mids: readonly string[]): Promise<void>
  clear(): Promise<void>
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

const PENDING = 'pending:'
const pendingKey = (mid: string) => `${PENDING}${mid}`

/** Oldest first, as they were made; `mid` only orders two made in the same millisecond. */
function inOrder(entries: Iterable<Pending>): Pending[] {
  const byMid = new Map<string, Pending>()
  for (const e of entries) byMid.set(e.mutation.mid, e)
  return [...byMid.values()].sort(
    (a, b) => a.mutation.at - b.mutation.at || a.mutation.mid.localeCompare(b.mutation.mid),
  )
}

export async function indexedDbPersistence(name = 'tela'): Promise<Persistence> {
  const db: IDBPDatabase<TelaDB> = await openDB<TelaDB>(name, 1, {
    upgrade(d) {
      d.createObjectStore('meta')
      d.createObjectStore('tables')
      d.createObjectStore('bodies', { keyPath: 'key' }).createIndex('lastOpened', 'lastOpened')
      d.createObjectStore('objects', { keyPath: 'key' })
    },
  })
  return {
    async load() {
      const tx = db.transaction(['meta', 'tables'])
      const meta = tx.objectStore('meta')
      const [userId, cursor, legacy, keyed] = await Promise.all([
        meta.get('userId'),
        meta.get('cursor'),
        meta.get('pending'),
        meta.getAll(IDBKeyRange.bound(PENDING, `${PENDING}\uffff`)),
      ])
      const values = await Promise.all(TABLES.map((t) => tx.objectStore('tables').get(t)))
      const complete = values.every((v) => v !== undefined)
      const rows = complete
        ? (Object.fromEntries(TABLES.map((t, i) => [t, values[i]])) as TableRows)
        : null
      // An earlier build kept the whole list in one record: move it into records of its own.
      const old = (legacy as Pending[] | undefined) ?? []
      if (legacy !== undefined) {
        const move = db.transaction('meta', 'readwrite')
        for (const e of old) await move.store.put(e, pendingKey(e.mutation.mid))
        await move.store.delete('pending')
        await move.done
      }
      return {
        userId: (userId as string | undefined) ?? null,
        cursor: rows ? Number(cursor ?? 0) : 0,
        rows,
        pending: inOrder([...old, ...(keyed as Pending[])]),
      }
    },
    async storedUserId() {
      return ((await db.get('meta', 'userId')) as string | undefined) ?? null
    },
    async saveTables(rows) {
      const tx = db.transaction('tables', 'readwrite')
      for (const [name, value] of Object.entries(rows)) {
        await tx.store.put(value, name as keyof TableRows)
      }
      await tx.done
    },
    async saveMeta(meta) {
      const tx = db.transaction('meta', 'readwrite')
      if (meta.cursor !== undefined) await tx.store.put(meta.cursor, 'cursor')
      if (meta.userId !== undefined) await tx.store.put(meta.userId, 'userId')
      await tx.done
    },
    async savePending(entries) {
      if (entries.length === 0) return
      const tx = db.transaction('meta', 'readwrite')
      for (const e of entries) await tx.store.put(e, pendingKey(e.mutation.mid))
      await tx.done
    },
    async dropPending(mids) {
      if (mids.length === 0) return
      const tx = db.transaction('meta', 'readwrite')
      for (const mid of mids) await tx.store.delete(pendingKey(mid))
      await tx.done
    },
    async clear() {
      const tx = db.transaction(['meta', 'tables', 'bodies', 'objects'], 'readwrite')
      await Promise.all([
        tx.objectStore('meta').clear(),
        tx.objectStore('tables').clear(),
        tx.objectStore('bodies').clear(),
        tx.objectStore('objects').clear(),
      ])
      await tx.done
    },
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

/** Storage that forgets everything: tests, and browsers that refuse IndexedDB. */
export function memoryPersistence(): Persistence {
  let meta: Omit<Persisted, 'rows' | 'pending'> = { userId: null, cursor: 0 }
  const pending = new Map<string, Pending>()
  let tables: Partial<TableRows> = {}
  const bodies = new Map<string, StoredBody>()
  const objects = new Map<string, StoredObject>()
  return {
    async load() {
      const complete = TABLES.every((t) => t in tables)
      return {
        ...meta,
        rows: complete ? (tables as TableRows) : null,
        pending: inOrder(pending.values()),
      }
    },
    storedUserId: async () => meta.userId,
    async saveTables(rows) {
      tables = { ...tables, ...rows }
    },
    async saveMeta(m) {
      meta = {
        ...meta,
        ...(m.cursor !== undefined ? { cursor: m.cursor } : {}),
        ...(m.userId !== undefined ? { userId: m.userId } : {}),
      }
    },
    async savePending(entries) {
      for (const e of entries) pending.set(e.mutation.mid, e)
    },
    async dropPending(mids) {
      for (const mid of mids) pending.delete(mid)
    },
    async clear() {
      meta = { userId: null, cursor: 0 }
      pending.clear()
      tables = {}
      bodies.clear()
      objects.clear()
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

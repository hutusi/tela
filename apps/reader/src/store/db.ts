/**
 * What the device keeps between visits, in IndexedDB (`idb`: a thin wrapper over the web
 * standard, chosen so there is almost nothing between Tela and the browser to age):
 *
 * - `meta`: the cursor, who the rows belong to, and the pending mutations.
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
  saveTables(rows: Partial<TableRows>): Promise<void>
  saveMeta(meta: { cursor?: number; pending?: Pending[]; userId?: string | null }): Promise<void>
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
  'claims',
  'translations',
]

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
      const [userId, cursor, pending] = await Promise.all([
        tx.objectStore('meta').get('userId'),
        tx.objectStore('meta').get('cursor'),
        tx.objectStore('meta').get('pending'),
      ])
      const values = await Promise.all(TABLES.map((t) => tx.objectStore('tables').get(t)))
      const complete = values.every((v) => v !== undefined)
      const rows = complete
        ? (Object.fromEntries(TABLES.map((t, i) => [t, values[i]])) as TableRows)
        : null
      return {
        userId: (userId as string | undefined) ?? null,
        cursor: rows ? Number(cursor ?? 0) : 0,
        rows,
        pending: (pending as Pending[] | undefined) ?? [],
      }
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
      if (meta.pending !== undefined) await tx.store.put(meta.pending, 'pending')
      if (meta.userId !== undefined) await tx.store.put(meta.userId, 'userId')
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
  let meta: Persisted = { userId: null, cursor: 0, rows: null, pending: [] }
  let tables: Partial<TableRows> = {}
  const bodies = new Map<string, StoredBody>()
  const objects = new Map<string, StoredObject>()
  return {
    async load() {
      const complete = TABLES.every((t) => t in tables)
      return { ...meta, rows: complete ? (tables as TableRows) : null }
    },
    async saveTables(rows) {
      tables = { ...tables, ...rows }
    },
    async saveMeta(m) {
      meta = {
        ...meta,
        ...(m.cursor !== undefined ? { cursor: m.cursor } : {}),
        ...(m.pending !== undefined ? { pending: m.pending } : {}),
        ...(m.userId !== undefined ? { userId: m.userId } : {}),
      }
    },
    async clear() {
      meta = { userId: null, cursor: 0, rows: null, pending: [] }
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

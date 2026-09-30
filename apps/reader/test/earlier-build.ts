/**
 * A device database as the builds before owners wrote it: whose rows in `userId` (or nowhere),
 * every table, the cursor, and pending changes both as the one-record list and untagged records.
 * Raw `idb`, since the current storage cannot write rows that belong to no one.
 */
import { applyPull, emptyTables, type Pending, type PullResponse, rowsOf } from '@tela/sync'
import { openDB } from 'idb'

export async function seedEarlierBuild(
  name: string,
  snapshot: PullResponse,
  seed: { userId?: string; legacy?: Pending[]; keyed?: Pending[] } = {},
): Promise<void> {
  const db = await openDB(name, 1, {
    upgrade(d) {
      d.createObjectStore('meta')
      d.createObjectStore('tables')
      d.createObjectStore('bodies', { keyPath: 'key' }).createIndex('lastOpened', 'lastOpened')
      d.createObjectStore('objects', { keyPath: 'key' })
    },
  })
  const confirmed = applyPull({ cursor: 0, tables: emptyTables() }, snapshot)
  const tx = db.transaction(['meta', 'tables', 'bodies'], 'readwrite')
  for (const [table, rows] of Object.entries(rowsOf(confirmed.tables))) {
    await tx.objectStore('tables').put(rows, table)
  }
  const meta = tx.objectStore('meta')
  await meta.put(confirmed.cursor, 'cursor')
  if (seed.userId !== undefined) await meta.put(seed.userId, 'userId')
  if (seed.legacy) await meta.put(seed.legacy, 'pending')
  for (const e of seed.keyed ?? []) await meta.put(e, `pending:${e.mutation.mid}`)
  await tx.objectStore('bodies').put({ key: 'c1', object: {}, bytes: 2, lastOpened: 0 })
  await tx.done
  db.close()
}

/** Whose rows the copy says these are, under this build's key or an earlier one's. */
export async function storedOwner(name: string): Promise<string | null> {
  const db = await openDB(name, 1)
  try {
    return ((await db.get('meta', 'owner')) ?? (await db.get('meta', 'userId')) ?? null) as
      | string
      | null
  } finally {
    db.close()
  }
}

/** Every key the `meta` store holds, raw. */
export async function metaKeys(name: string): Promise<string[]> {
  const db = await openDB(name, 1)
  try {
    return (await db.getAllKeys('meta')).map(String).sort()
  } finally {
    db.close()
  }
}

/** An earlier build's sign-out, as cb096cb's store.clear() does it: every store emptied. */
export async function signOutEarlierBuild(name: string): Promise<void> {
  const db = await openDB(name, 1)
  try {
    const names = Array.from(db.objectStoreNames)
    const tx = db.transaction(names, 'readwrite')
    await Promise.all(names.map((n) => tx.objectStore(n).clear()))
    await tx.done
  } finally {
    db.close()
  }
}

/** No earlier build has ever run on this device. */
export function noEarlierBuild(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(name)
    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error)
  })
}

/**
 * The nightly export (ADR 0027): every table worth keeping, as JSON lines in the blob store, with a
 * manifest of row counts and hashes that a second pass reads back to verify. D1's Time Travel is
 * the point-in-time copy; this one is portable. It is what boots Tela off Cloudflare, and the
 * test suite restores it into a fresh libSQL database and serves from it, so it stays that.
 *
 * Tables come from the Drizzle schema, parents before children, so a restore can insert them in
 * order. The export is not one snapshot: tables are read one after another while writes go on, so
 * a child can name a parent written after its table was read. Restoring therefore turns foreign
 * key checks off. An orphan costs a missing join, nothing more.
 *
 * Within a table, rows are read in primary-key order, and each page starts after the last key
 * the page before it read, never at an OFFSET, which any write behind the cursor moves. So rows
 * written meanwhile are neither repeated nor skipped: a row there throughout is read exactly once,
 * and one written or deleted meanwhile at most once. A table without a primary key (tombstones)
 * pages by rowid the same way.
 */
import type { Blobs } from '@tela/platform'
import { is, type SQL, sql } from 'drizzle-orm'
import { toSnakeCase } from 'drizzle-orm/casing'
import { getTableConfig, SQLiteTable } from 'drizzle-orm/sqlite-core'
import type { TelaDb } from './db'
import * as schema from './schema'

export const BACKUP_PREFIX = 'backup/'
/** The newest export and whether it verified: the digest and the health check read only this. */
export const LATEST_BACKUP = `${BACKUP_PREFIX}latest.json`
const PAGE_ROWS = 1000
const PART_ROWS = 5000
const RESTORE_CHUNK = 200

/**
 * Not kept: leases, limits and heartbeats are live coordination, rebuilt as work runs; sign-in
 * codes and sessions are credentials, and a restored database signs everyone in again.
 */
const SKIPPED = new Set([
  'leases',
  'lease_fence',
  'rate_limit',
  'action_limits',
  'ops_heartbeats',
  'verification',
  'session',
])

export type BackupTable = {
  name: string
  /** The primary key the export pages by; null for a table without one, which pages by rowid. */
  key: string[] | null
  parents: string[]
}

/** A column's name in the database: the schema's keys are camelCase, its columns snake_case. */
const columnName = (column: { name: string; keyAsName: boolean }) =>
  column.keyAsName ? toSnakeCase(column.name) : column.name

/** The tables an export holds, each after the tables it references. */
export function backupTables(): BackupTable[] {
  const tables: BackupTable[] = []
  for (const value of Object.values(schema)) {
    if (!is(value, SQLiteTable)) continue
    const config = getTableConfig(value)
    if (SKIPPED.has(config.name)) continue
    const key =
      config.primaryKeys[0]?.columns.map(columnName) ??
      config.columns.filter((c) => c.primary).map(columnName)
    const parents = config.foreignKeys
      .map((fk) => getTableConfig(fk.reference().foreignTable).name)
      .filter((name) => name !== config.name && !SKIPPED.has(name))
    tables.push({ name: config.name, key: key.length > 0 ? key : null, parents })
  }
  const ordered: BackupTable[] = []
  const placed = new Set<string>()
  while (ordered.length < tables.length) {
    const ready = tables.filter((t) => !placed.has(t.name) && t.parents.every((p) => placed.has(p)))
    if (ready.length === 0) throw new Error('the schema has a foreign-key cycle')
    for (const t of ready.sort((a, b) => a.name.localeCompare(b.name))) {
      ordered.push(t)
      placed.add(t.name)
    }
  }
  return ordered
}

export type BackupPart = { key: string; rows: number; sha256: string }
export type BackupManifest = {
  format: 1
  date: string
  startedAt: number
  finishedAt: number
  /** `key` is what the table was paged by, which verification checks the rows' order against. */
  tables: { name: string; key: string[] | null; rows: number; parts: BackupPart[] }[]
}
export type LatestBackup = {
  date: string
  finishedAt: number
  rows: number
  verified: boolean
  problems: string[]
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

const manifestKey = (date: string) => `${BACKUP_PREFIX}${date}/manifest.json`

/** What a table without a primary key is paged by, read beside its row and left out of the line. */
const ROWID = '__backup_rowid'

/** One page of `table` in key order, after the key values `after` (from its start when null). */
function pageQuery(table: BackupTable, after: unknown[] | null): SQL {
  const name = sql.identifier(table.name)
  if (!table.key) {
    const from = after ? sql`where rowid > ${after[0]}` : sql.empty()
    return sql`select rowid as ${sql.identifier(ROWID)}, * from ${name} ${from}
      order by rowid limit ${PAGE_ROWS}`
  }
  const key = sql.join(
    table.key.map((c) => sql.identifier(c)),
    sql`, `,
  )
  const from = after
    ? sql`where (${key}) > (${sql.join(
        after.map((v) => sql`${v}`),
        sql`, `,
      )})`
    : sql.empty()
  return sql`select * from ${name} ${from} order by ${key} limit ${PAGE_ROWS}`
}

const utf8 = new TextEncoder()

/** SQLite's order for key values: numbers before text, and text by its UTF-8 bytes (BINARY). */
function compareValues(a: unknown, b: unknown): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b
  if (typeof a === 'string' && typeof b === 'string') {
    const x = utf8.encode(a)
    const y = utf8.encode(b)
    for (let i = 0; i < Math.min(x.length, y.length); i++) {
      if (x[i] !== y[i]) return (x[i] ?? 0) - (y[i] ?? 0)
    }
    return x.length - y.length
  }
  const rank = (v: unknown) => (v === null ? 0 : typeof v === 'number' ? 1 : 2)
  return rank(a) - rank(b)
}

function compareKeys(a: unknown[], b: unknown[]): number {
  for (let i = 0; i < a.length; i++) {
    const order = compareValues(a[i], b[i])
    if (order !== 0) return order
  }
  return 0
}

function parseRow(line: string): Record<string, unknown> | null {
  try {
    const row: unknown = JSON.parse(line)
    return typeof row === 'object' && row !== null ? (row as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** Whether `lines` go on ascending by `key` from `previous`, and the last key they reach. */
function keyOrder(
  lines: string[],
  key: string[],
  previous: unknown[] | null,
): { last: unknown[] | null; problem: string | null } {
  let last = previous
  for (const [i, line] of lines.entries()) {
    const row = parseRow(line)
    if (!row) return { last, problem: `line ${i + 1} is not a JSON object` }
    const values = key.map((c) => row[c])
    if (last && compareKeys(last, values) >= 0) {
      return { last, problem: `line ${i + 1} is out of key order: ${JSON.stringify(values)}` }
    }
    last = values
  }
  return { last, problem: null }
}

/** Write every table under `backup/<date>/`, then the manifest that names the parts. */
export async function exportDatabase(
  db: TelaDb,
  blobs: Blobs,
  options: { date: string; now: () => number },
): Promise<BackupManifest> {
  const startedAt = options.now()
  const manifest: BackupManifest = {
    format: 1,
    date: options.date,
    startedAt,
    finishedAt: 0,
    tables: [],
  }
  for (const table of backupTables()) {
    const parts: BackupPart[] = []
    let lines: string[] = []
    let rows = 0
    const flush = async () => {
      if (lines.length === 0) return
      const text = `${lines.join('\n')}\n`
      const key = `${BACKUP_PREFIX}${options.date}/${table.name}.${parts.length}.jsonl`
      await blobs.put(key, text, { contentType: 'application/x-ndjson' })
      parts.push({ key, rows: lines.length, sha256: await sha256(text) })
      lines = []
    }
    const { key } = table
    let after: unknown[] | null = null
    for (;;) {
      const page: Record<string, unknown>[] = await db.all(pageQuery(table, after))
      const last = page.at(-1)
      if (last) after = key ? key.map((c) => last[c]) : [last[ROWID]]
      for (const row of page) {
        if (!key) delete row[ROWID]
        lines.push(JSON.stringify(row))
      }
      rows += page.length
      if (lines.length >= PART_ROWS) await flush()
      if (page.length < PAGE_ROWS) break
    }
    await flush()
    manifest.tables.push({ name: table.name, key, rows, parts })
  }
  manifest.finishedAt = options.now()
  await blobs.put(manifestKey(options.date), JSON.stringify(manifest), {
    contentType: 'application/json',
  })
  return manifest
}

export async function readManifest(blobs: Blobs, date: string): Promise<BackupManifest | null> {
  const object = await blobs.get(manifestKey(date))
  return object ? (JSON.parse(await object.text()) as BackupManifest) : null
}

/**
 * Read an export back: every part present, as many lines as it says, with the hash it says, and
 * a keyed table's rows in strictly increasing key order across its parts. The counts alone pass a
 * row read twice, since the manifest counted the same lines; the order does not.
 */
export async function verifyExport(
  blobs: Blobs,
  date: string,
): Promise<{ ok: boolean; problems: string[] }> {
  const manifest = await readManifest(blobs, date)
  if (!manifest) return { ok: false, problems: [`no manifest for ${date}`] }
  const problems: string[] = []
  for (const table of manifest.tables) {
    let rows = 0
    let previous: unknown[] | null = null
    let ordered = true
    for (const part of table.parts) {
      const object = await blobs.get(part.key)
      if (!object) {
        problems.push(`${part.key} is missing`)
        continue
      }
      const text = await object.text()
      const lines = text.split('\n').filter((l) => l !== '')
      if (lines.length !== part.rows) {
        problems.push(`${part.key} has ${lines.length} rows, not ${part.rows}`)
      }
      if ((await sha256(text)) !== part.sha256) problems.push(`${part.key} does not match its hash`)
      rows += lines.length
      if (table.key && ordered) {
        const order = keyOrder(lines, table.key, previous)
        previous = order.last
        if (order.problem) {
          problems.push(`${part.key} ${order.problem}`)
          ordered = false
        }
      }
    }
    if (rows !== table.rows) problems.push(`${table.name} has ${rows} rows, not ${table.rows}`)
  }
  return { ok: problems.length === 0, problems }
}

/** Export, verify, and record the result where the digest and the health check look. */
export async function backUp(
  db: TelaDb,
  blobs: Blobs,
  options: { date: string; now: () => number },
): Promise<LatestBackup> {
  const manifest = await exportDatabase(db, blobs, options)
  const verified = await verifyExport(blobs, options.date)
  const latest: LatestBackup = {
    date: options.date,
    finishedAt: manifest.finishedAt,
    rows: manifest.tables.reduce((n, t) => n + t.rows, 0),
    verified: verified.ok,
    problems: verified.problems.slice(0, 20),
  }
  await blobs.put(LATEST_BACKUP, JSON.stringify(latest), { contentType: 'application/json' })
  return latest
}

export async function latestBackup(blobs: Blobs): Promise<LatestBackup | null> {
  const object = await blobs.get(LATEST_BACKUP)
  return object ? (JSON.parse(await object.text()) as LatestBackup) : null
}

/**
 * Load an export into an empty, migrated database: the exit path's first step (OPERATIONS.md).
 * Tables go in the manifest's order, a few hundred rows a statement through one JSON parameter.
 * The inserts are plain, so a row already there is an error, and a database holding any row of a
 * table the export names is refused before anything is written. A restore that fails partway is
 * not undone: start again from a fresh database.
 */
export async function restoreDatabase(
  db: TelaDb,
  blobs: Blobs,
  date: string,
): Promise<{ rows: number }> {
  const manifest = await readManifest(blobs, date)
  if (!manifest) throw new Error(`no manifest for ${date}`)
  for (const table of manifest.tables) {
    const held = await db.all(sql`select 1 from ${sql.identifier(table.name)} limit 1`)
    if (held.length > 0) {
      throw new Error(`restore needs an empty database, and ${table.name} already has rows`)
    }
  }
  await db.run(sql`pragma foreign_keys = off`)
  let total = 0
  try {
    for (const table of manifest.tables) {
      for (const part of table.parts) {
        const object = await blobs.get(part.key)
        if (!object) throw new Error(`${part.key} is missing`)
        const rows = (await object.text())
          .split('\n')
          .filter((l) => l !== '')
          .map((l) => JSON.parse(l) as Record<string, unknown>)
        for (let i = 0; i < rows.length; i += RESTORE_CHUNK) {
          const chunk = rows.slice(i, i + RESTORE_CHUNK)
          const columns = Object.keys(chunk[0] ?? {})
          await db.run(sql`
            insert into ${sql.identifier(table.name)} (${sql.join(
              columns.map((c) => sql.identifier(c)),
              sql`, `,
            )})
            select ${sql.join(
              columns.map((c) => sql`json_extract(value, ${`$."${c}"`})`),
              sql`, `,
            )}
            from json_each(${JSON.stringify(chunk)}) where true
          `)
          total += chunk.length
        }
      }
    }
  } finally {
    await db.run(sql`pragma foreign_keys = on`)
  }
  return { rows: total }
}

/** Delete exports older than `keepDays` before `today` (YYYY-MM-DD). */
export async function pruneBackups(blobs: Blobs, today: string, keepDays: number): Promise<number> {
  const cutoff = new Date(Date.parse(`${today}T00:00:00Z`) - keepDays * 86_400_000)
    .toISOString()
    .slice(0, 10)
  let deleted = 0
  let cursor: string | undefined
  do {
    const page = await blobs.list({ prefix: BACKUP_PREFIX, ...(cursor ? { cursor } : {}) })
    for (const key of page.keys) {
      const date = key.slice(BACKUP_PREFIX.length, BACKUP_PREFIX.length + 10)
      if (/^\d{4}-\d{2}-\d{2}$/.test(date) && date < cutoff) {
        await blobs.delete(key)
        deleted++
      }
    }
    cursor = page.cursor ?? undefined
  } while (cursor)
  return deleted
}

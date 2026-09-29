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
 */
import type { Blobs } from '@tela/platform'
import { is, sql } from 'drizzle-orm'
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

export type BackupTable = { name: string; key: string[]; parents: string[] }

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
    tables.push({
      name: config.name,
      key: key.length > 0 ? key : config.columns.map(columnName),
      parents,
    })
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
  tables: { name: string; rows: number; parts: BackupPart[] }[]
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
    const order = sql.join(
      table.key.map((c) => sql.identifier(c)),
      sql`, `,
    )
    for (let offset = 0; ; offset += PAGE_ROWS) {
      const page = await db.all<Record<string, unknown>>(
        sql`select * from ${sql.identifier(table.name)} order by ${order} limit ${PAGE_ROWS} offset ${offset}`,
      )
      for (const row of page) lines.push(JSON.stringify(row))
      rows += page.length
      if (lines.length >= PART_ROWS) await flush()
      if (page.length < PAGE_ROWS) break
    }
    await flush()
    manifest.tables.push({ name: table.name, rows, parts })
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

/** Read an export back: every part present, as many lines as it says, with the hash it says. */
export async function verifyExport(
  blobs: Blobs,
  date: string,
): Promise<{ ok: boolean; problems: string[] }> {
  const manifest = await readManifest(blobs, date)
  if (!manifest) return { ok: false, problems: [`no manifest for ${date}`] }
  const problems: string[] = []
  for (const table of manifest.tables) {
    let rows = 0
    for (const part of table.parts) {
      const object = await blobs.get(part.key)
      if (!object) {
        problems.push(`${part.key} is missing`)
        continue
      }
      const text = await object.text()
      const lines = text.split('\n').filter((l) => l !== '').length
      if (lines !== part.rows) problems.push(`${part.key} has ${lines} rows, not ${part.rows}`)
      if ((await sha256(text)) !== part.sha256) problems.push(`${part.key} does not match its hash`)
      rows += lines
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
 */
export async function restoreDatabase(
  db: TelaDb,
  blobs: Blobs,
  date: string,
): Promise<{ rows: number }> {
  const manifest = await readManifest(blobs, date)
  if (!manifest) throw new Error(`no manifest for ${date}`)
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

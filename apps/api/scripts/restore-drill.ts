/**
 * The restore drill (OPERATIONS.md, "Restoring"): take the newest nightly export from R2, load it
 * into a fresh libSQL file the way the exit path would, and check that what comes back is whole
 * and works. Nothing is written anywhere but a scratch directory, which is deleted at the end:
 * the export holds members' addresses and password hashes.
 *
 *   bun run restore-drill                 # the newest export
 *   bun run restore-drill --date 2026-10-25
 *   bun run restore-drill --keep          # keep the scratch directory (and say where it is)
 *
 * It reads R2 through `wrangler r2 object get --remote`, with the wrangler login that deploys,
 * so it needs no S3 credentials of its own.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { parseArgs } from 'node:util'
import { type BackupManifest, type JobQueues, restoreDatabase, schema } from '@tela/data'
import { migrationStatements } from '@tela/data/testing'
import type { Blobs } from '@tela/platform'
import { libsqlDb, memoryBlobs, memoryJobs, memoryMail } from '@tela/platform/portable'
import { isReadingLanguage } from '@tela/shared'
import { sql } from 'drizzle-orm'
import { createApp } from '../src/app'
import type { ApiDeps } from '../src/deps'
import { answerPull } from '../src/sync/pull'

const { values } = parseArgs({
  options: { date: { type: 'string' }, keep: { type: 'boolean', default: false } },
})
const BUCKET = 'tela-content'
const apiDir = join(import.meta.dirname, '..')
const scratch = mkdtempSync(join(tmpdir(), 'tela-restore-drill-'))
const timings: [string, number][] = []
const problems: string[] = []

async function step<T>(name: string, run: () => Promise<T> | T): Promise<T> {
  const start = performance.now()
  const result = await run()
  timings.push([name, Math.round(performance.now() - start)])
  return result
}

/** One object from R2 into the scratch directory, through wrangler. */
function download(key: string): string {
  const file = join(scratch, key)
  execFileSync('mkdir', ['-p', dirname(file)])
  execFileSync(
    'bunx',
    ['wrangler', 'r2', 'object', 'get', `${BUCKET}/${key}`, '--remote', '--file', file],
    { cwd: apiDir, env: { ...process.env, CI: 'true' }, stdio: ['ignore', 'ignore', 'pipe'] },
  )
  return file
}

try {
  const date =
    values.date ??
    (JSON.parse(readFileSync(download('backup/latest.json'), 'utf8')) as { date: string }).date
  console.log(`restoring the export of ${date} into ${scratch}`)

  const manifestKey = `backup/${date}/manifest.json`
  const manifest = JSON.parse(readFileSync(download(manifestKey), 'utf8')) as BackupManifest
  const parts = manifest.tables.flatMap((t) => t.parts)
  let bytes = 0
  const blobs: Blobs = memoryBlobs()
  await step(`download ${parts.length} parts`, async () => {
    await blobs.put(manifestKey, JSON.stringify(manifest))
    for (const part of parts) {
      const file = download(part.key)
      bytes += statSync(file).size
      await blobs.put(part.key, readFileSync(file, 'utf8'))
    }
  })

  const dbFile = join(scratch, 'restored.db')
  const { db, client } = libsqlDb({ url: `file:${dbFile}`, schema })
  await step('migrate a fresh database', async () => {
    await client.execute('pragma foreign_keys = on')
    for (const migration of migrationStatements()) await client.batch(migration.statements)
  })

  const restored = await step('restore', () => restoreDatabase(db, blobs, date))
  const expected = manifest.tables.reduce((n, t) => n + t.rows, 0)
  if (restored.rows !== expected) problems.push(`restored ${restored.rows} rows, not ${expected}`)

  await step('check row counts', async () => {
    for (const table of manifest.tables) {
      const [row] = (await db.all(
        sql`select count(*) as n from ${sql.identifier(table.name)}`,
      )) as { n: number }[]
      if (row?.n !== table.rows) problems.push(`${table.name}: ${row?.n} rows, not ${table.rows}`)
    }
  })
  await step('integrity and foreign keys', async () => {
    const integrity = (await client.execute('pragma integrity_check')).rows
    if (String(integrity[0]?.[0]) !== 'ok') problems.push(`integrity_check: ${integrity[0]?.[0]}`)
    const orphans = (await client.execute('pragma foreign_key_check')).rows
    if (orphans.length > 0) problems.push(`${orphans.length} rows reference a missing parent`)
  })

  // Tela on the restored copy: the public pages' answers, and an admin's first sync, which
  // reads nearly every table a device holds.
  const deps: ApiDeps = {
    db,
    blobs,
    jobs: memoryJobs<JobQueues>(),
    clock: { now: () => Date.now() },
    mail: memoryMail(),
    ingest: {} as ApiDeps['ingest'],
    config: {
      publicUrl: 'https://telaread.com',
      authSecret: `${crypto.randomUUID()}${crypto.randomUUID()}`,
      mailFrom: 'drill',
    },
  }
  const { app } = createApp(deps)
  await step('public pages answer', async () => {
    const [site] = (await db.all(
      sql`select id from sites where listing in ('listed', 'featured') order by id limit 1`,
    )) as { id: number }[]
    for (const path of [
      '/api/v1/public/front',
      '/api/v1/public/discover',
      '/api/v1/public/discover/week',
      '/api/v1/public/discover/articles',
      ...(site ? [`/api/v1/public/sites/${site.id}`] : []),
    ]) {
      const res = await app.request(`https://telaread.com${path}`)
      if (res.status !== 200) problems.push(`${path} answered ${res.status}`)
    }
  })
  const pulled = await step("an admin's first sync", async () => {
    const [admin] = (await db.all(
      sql`select user_id, coalesce(reading_lang, ui_locale, 'en') as lang from profiles
        where is_admin = 1 limit 1`,
    )) as { user_id: string; lang: string }[]
    if (!admin) {
      problems.push('no admin to sync as')
      return null
    }
    // As a device asks: titles in its reading language only (ADR 0052).
    const lang = isReadingLanguage(admin.lang) ? admin.lang : 'en'
    const pull = await answerPull(db, admin.user_id, 0, Date.now(), lang)
    return JSON.stringify(pull).length
  })

  const report = [
    `export ${date}: ${manifest.tables.length} tables, ${expected} rows, ${parts.length} parts, ${Math.round(bytes / 1024)} KB`,
    `restored ${restored.rows} rows into ${Math.round(statSync(dbFile).size / 1024)} KB of SQLite`,
    ...(pulled === null ? [] : [`an admin's first sync: ${Math.round(pulled / 1024)} KB`]),
    ...timings.map(([name, ms]) => `  ${name}: ${ms} ms`),
    problems.length === 0 ? 'OK: the restore is whole and Tela runs on it' : 'PROBLEMS:',
    ...problems.map((p) => `  ${p}`),
  ].join('\n')
  console.log(report)
  writeFileSync(join(scratch, 'report.txt'), `${report}\n`)
  client.close()
  if (problems.length > 0) process.exitCode = 1
} finally {
  if (values.keep) console.log(`kept ${scratch}`)
  else rmSync(scratch, { recursive: true, force: true })
}

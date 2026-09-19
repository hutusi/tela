import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findForbidden } from './preflight-deploy'

const dirs: string[] = []
function envDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'tela-preflight-'))
  dirs.push(dir)
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body)
  return dir
}

const LOCAL = 'postgresql://postgres@127.0.0.1:54322/postgres'
/** No file explains this one, so it can only have come from the shell. */
const none: Record<string, string | undefined> = {}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('deploy preflight', () => {
  test('passes when nothing carries local config', () => {
    expect(findForbidden(envDir({}), none)).toEqual([])
    const dir = envDir({ '.env': 'NEXT_PUBLIC_SITE_URL=https://example.com\n' })
    expect(findForbidden(dir, none)).toEqual([])
  })

  test('catches the outage: a dev DATABASE_URL in .env', () => {
    // getDb prefers an explicit URL over the HYPERDRIVE binding, so this one took the site down.
    const dir = envDir({ '.env': `DATABASE_URL=${LOCAL}\n` })
    expect(findForbidden(dir, none)).toEqual([
      {
        key: 'DATABASE_URL',
        source: 'apps/web/.env',
        why: expect.stringContaining('HYPERDRIVE'),
      },
    ])
  })

  test('catches one from the shell, which touches no file at all', () => {
    // `DATABASE_URL=… bun run deploy` — the build inherits it and bakes it in.
    const found = findForbidden(envDir({}), { DATABASE_URL: LOCAL })
    expect(found.map((f) => [f.key, f.source])).toEqual([
      ['DATABASE_URL', 'the environment this deploy runs in'],
    ])
  })

  test('a value a file supplies is attributed to the file, not the shell', () => {
    // Bun loads .env into the environment before this script runs.
    const dir = envDir({ '.env': `DATABASE_URL=${LOCAL}\n` })
    expect(findForbidden(dir, { DATABASE_URL: LOCAL })[0]?.source).toBe('apps/web/.env')
  })

  test('a production URL is refused too, not just a local one', () => {
    // Any baked URL bypasses Hyperdrive's pooling, which is the point of the binding.
    const dir = envDir({ '.env': 'DATABASE_URL=postgresql://user@db.example.com:5432/postgres\n' })
    expect(findForbidden(dir, none).map((f) => f.key)).toEqual(['DATABASE_URL'])
  })

  test('empty means off, and for a URL only empty does', () => {
    expect(findForbidden(envDir({ '.env': 'DATABASE_URL=\nTELA_DEV_AUTH=0\n' }), none)).toEqual([])
    // getDb tests DATABASE_URL for truthiness, so `0` is a host called `0`, not a disabled setting.
    const dir = envDir({ '.env': 'DATABASE_URL=0\n' })
    expect(findForbidden(dir, none).map((f) => f.key)).toEqual(['DATABASE_URL'])
  })

  test('the first file to mention a key wins, whatever its value', () => {
    const shadowed = envDir({
      '.env.production': `DATABASE_URL=${LOCAL}\n`,
      '.env': 'DATABASE_URL=postgresql://user@db.example.com:5432/postgres\n',
    })
    expect(findForbidden(shadowed, none)[0]?.source).toBe('apps/web/.env.production')

    // An empty value in the higher-priority file genuinely disables the lower one, so refusing
    // here would be a deploy blocked for no reason.
    const disabled = envDir({
      '.env.production': 'DATABASE_URL=\n',
      '.env': `DATABASE_URL=${LOCAL}\n`,
    })
    expect(findForbidden(disabled, { DATABASE_URL: LOCAL })).toEqual([])
  })

  test('reads the syntax Next reads: export, quotes, comments', () => {
    // dotenv strips `export`, so a guard that did not would miss the value Next loads.
    const dir = envDir({ '.env': `# DATABASE_URL=ignored\nexport DATABASE_URL="${LOCAL}"\n` })
    expect(findForbidden(dir, none).map((f) => f.key)).toEqual(['DATABASE_URL'])
  })

  test('dev auth is refused as well', () => {
    const dir = envDir({ '.env': 'TELA_DEV_AUTH=1\n' })
    expect(findForbidden(dir, none).map((f) => f.key)).toEqual(['TELA_DEV_AUTH'])
  })
})

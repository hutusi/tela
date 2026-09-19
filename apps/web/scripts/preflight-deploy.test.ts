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

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('deploy preflight', () => {
  test('passes when no env file carries local config', () => {
    expect(findForbidden(envDir({}))).toEqual([])
    expect(findForbidden(envDir({ '.env': 'NEXT_PUBLIC_SITE_URL=https://example.com\n' }))).toEqual(
      [],
    )
  })

  test('catches the outage: a dev DATABASE_URL in .env', () => {
    // getDb prefers an explicit URL over the HYPERDRIVE binding, so this one took the site down.
    const dir = envDir({ '.env': 'DATABASE_URL=postgresql://postgres@127.0.0.1:54322/postgres\n' })
    expect(findForbidden(dir)).toEqual([
      { key: 'DATABASE_URL', file: '.env', why: expect.stringContaining('HYPERDRIVE') },
    ])
  })

  test('a production URL is refused too, not just a local one', () => {
    // Any baked URL bypasses Hyperdrive's pooling, which is the point of the binding.
    const dir = envDir({ '.env': 'DATABASE_URL=postgresql://user@db.example.com:5432/postgres\n' })
    expect(findForbidden(dir).map((f) => f.key)).toEqual(['DATABASE_URL'])
  })

  test('an empty or zero value is how you turn one off', () => {
    expect(findForbidden(envDir({ '.env': 'DATABASE_URL=\nTELA_DEV_AUTH=0\n' }))).toEqual([])
  })

  test('reports each key once, naming the file Next would actually use', () => {
    const dir = envDir({
      '.env': 'DATABASE_URL=postgresql://postgres@127.0.0.1:54322/postgres\n',
      '.env.production': 'DATABASE_URL=postgresql://postgres@127.0.0.1:1111/postgres\n',
    })
    const found = findForbidden(dir)
    expect(found).toHaveLength(1)
    expect(found[0]?.file).toBe('.env.production')
  })

  test('dev auth is refused as well, and comments and quotes are ignored', () => {
    const dir = envDir({ '.env': '# TELA_DEV_AUTH=1\nTELA_DEV_AUTH="1"\n' })
    expect(findForbidden(dir).map((f) => f.key)).toEqual(['TELA_DEV_AUTH'])
  })
})

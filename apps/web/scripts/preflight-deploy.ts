/**
 * Refuse a deploy that would bake local development config into the Worker bundle.
 *
 * `next build` loads `.env*` from this directory and inlines what it finds, so a `DATABASE_URL`
 * meant for `next dev` becomes production config. `getDb` prefers an explicit URL over the
 * Hyperdrive binding (`src/lib/platform/db.ts`), so the deployed Worker then dials a database
 * that is not there and every request fails — which is exactly how the site went down on
 * 2026-09-18. Nothing warned: `.env` is gitignored, so `git status` stays clean and
 * `git checkout` silently does nothing, and `.env.example` ships the localhost URL that the
 * local-development runbook tells you to copy.
 *
 * On Workers the database comes from the HYPERDRIVE binding and `DATABASE_URL` must be unset.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const WEB = dirname(dirname(fileURLToPath(import.meta.url)))

/** The files Next loads for a production build, most specific first. */
const FILES = ['.env.production.local', '.env.local', '.env.production', '.env']

/**
 * Keys that must not reach the bundle, why, and the values that mean "off". Only an empty
 * `DATABASE_URL` is off: `getDb` tests it for truthiness, so `0` is a connection string to a
 * host called `0`, not a disabled setting.
 */
const FORBIDDEN: Record<string, { why: string; off: string[] }> = {
  DATABASE_URL: {
    why: 'the Worker takes its connection from the HYPERDRIVE binding; a baked URL wins over it and breaks every request',
    off: [''],
  },
  TELA_DEV_AUTH: {
    why: 'dev auth signs every request in as the development user',
    off: ['', '0'],
  },
}

/**
 * Minimal dotenv read: `KEY=value`, an optional `export` prefix (which dotenv strips, so Next
 * honours it and a guard that did not would miss the value), optional quotes, `#` comments, no
 * interpolation.
 */
function parse(text: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const raw of text.split('\n')) {
    const line = raw.trim().replace(/^export\s+/, '')
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq < 1) continue
    const key = line.slice(0, eq).trim()
    const value = line
      .slice(eq + 1)
      .trim()
      .replace(/^(['"])(.*)\1$/, '$2')
    if (!out.has(key)) out.set(key, value)
  }
  return out
}

export type Offender = { key: string; source: string; why: string }

/**
 * Forbidden keys the production build would pick up, from `dir`'s env files or from the
 * environment the deploy runs in.
 *
 * Two rules matter. Within the files, the first one to *mention* a key wins whatever its value,
 * because that is how Next resolves them — so an empty `DATABASE_URL` in `.env.production`
 * genuinely disables the one in `.env` and must not be reported. And a value in the environment
 * counts too: `DATABASE_URL=… bun run deploy` never touches a file, and the build inherits it.
 *
 * Bun loads `.env` into the environment before this script runs, so a value that matches one a
 * file supplies is attributed to the file and resolved by the rules above; only a value no file
 * explains can have come from the shell.
 */
export function findForbidden(
  dir: string,
  env: Record<string, string | undefined> = process.env,
): Offender[] {
  const found: Offender[] = []
  const files = FILES.map((file) => {
    const path = join(dir, file)
    return { file, values: existsSync(path) ? parse(readFileSync(path, 'utf8')) : undefined }
  })

  for (const [key, { why, off }] of Object.entries(FORBIDDEN)) {
    const defined = files.find((f) => f.values?.has(key))
    if (defined) {
      const value = defined.values?.get(key) as string
      if (!off.includes(value)) found.push({ key, source: `apps/web/${defined.file}`, why })
      continue
    }
    const fromEnv = env[key]
    if (fromEnv === undefined || off.includes(fromEnv)) continue
    found.push({ key, source: 'the environment this deploy runs in', why })
  }
  return found
}

if (import.meta.main) {
  const found = findForbidden(WEB)
  if (found.length > 0) {
    console.error('refusing to deploy: local development config would be built into the Worker\n')
    for (const { key, source, why } of found) {
      console.error(`  ${key} is set in ${source}`)
      console.error(`    ${why}\n`)
    }
    if (found.some((f) => f.source.startsWith('apps/web/'))) {
      console.error('Move the file aside for the deploy and put it back afterwards:')
      console.error('  mv apps/web/.env apps/web/.env.localdev\n')
    } else {
      console.error('Deploy from a shell that has not sourced them (a new terminal will do).\n')
    }
    process.exit(1)
  }
}

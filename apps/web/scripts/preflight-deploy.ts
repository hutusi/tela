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

/** Keys that must not reach the bundle, and why. */
const FORBIDDEN: Record<string, string> = {
  DATABASE_URL:
    'the Worker takes its connection from the HYPERDRIVE binding; a baked URL wins over it and breaks every request',
  TELA_DEV_AUTH: 'dev auth signs every request in as the development user',
}

/** Minimal dotenv read: `KEY=value`, optional quotes, `#` comments, no interpolation. */
function parse(text: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const raw of text.split('\n')) {
    const line = raw.trim()
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

export type Offender = { key: string; file: string; why: string }

/** Forbidden keys the production build would pick up from `dir`, most specific file winning. */
export function findForbidden(dir: string): Offender[] {
  const found: Offender[] = []
  for (const file of FILES) {
    const path = join(dir, file)
    if (!existsSync(path)) continue
    const values = parse(readFileSync(path, 'utf8'))
    for (const [key, why] of Object.entries(FORBIDDEN)) {
      const value = values.get(key)
      // An empty value is how you deliberately turn one off, and Next treats it as unset.
      if (value === undefined || value === '' || value === '0') continue
      if (found.some((f) => f.key === key)) continue // a more specific file already won
      found.push({ key, file, why })
    }
  }
  return found
}

if (import.meta.main) {
  const found = findForbidden(WEB)
  if (found.length > 0) {
    console.error('refusing to deploy: local development config would be built into the Worker\n')
    for (const { key, file, why } of found) {
      console.error(`  ${key} is set in apps/web/${file}`)
      console.error(`    ${why}\n`)
    }
    console.error('Move the file aside for the deploy and put it back afterwards:')
    console.error('  mv apps/web/.env apps/web/.env.localdev\n')
    process.exit(1)
  }
}

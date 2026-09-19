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
function parse(text: string): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const raw of text.split('\n')) {
    const line = raw.trim().replace(/^export\s+/, '')
    if (!line || line.startsWith('#')) continue
    // `KEY=value`, and `KEY: value` with whitespace after the colon -- both are in the regex
    // Next bundles (`@next/env`), so a guard that read only the first would miss the second.
    const m = /^([\w.-]+)(?:\s*=|:\s)\s*(.*)$/.exec(line)
    if (!m) continue
    const key = m[1] as string
    const value = (m[2] as string).trim().replace(/^(['"])(.*)\1$/, '$2')
    // Every declaration, not the first: dotenv keeps the last one a file makes, and a guard that
    // stopped at the first read `DATABASE_URL=` as decisive while Next took the URL below it.
    out.set(key, [...(out.get(key) ?? []), value])
  }
  return out
}

export type Offender = { key: string; source: string; why: string }

/**
 * Every place a forbidden key is set to something live: `dir`'s env files, and the environment
 * the deploy runs in.
 *
 * It deliberately does not model precedence. Which layer wins is genuinely ambiguous here — Bun
 * loads `.env` into the environment before any of this runs, Next's loader then reconciles its
 * own files against what it finds there, and the answer depends on NODE_ENV and on load order.
 * An earlier version guessed, and the guess is what let a shell-exported URL through while an
 * empty value in `.env.production` looked decisive.
 *
 * So the rule is: if a live value is reachable at all, refuse and name every place it came from.
 * A deploy blocked for a value that some other layer would have overridden costs a message and a
 * deleted line; the other way round costs an outage.
 */
export function findForbidden(
  dir: string,
  env: Record<string, string | undefined> = process.env,
): Offender[] {
  const found: Offender[] = []
  for (const [key, { why, off }] of Object.entries(FORBIDDEN)) {
    const seen: string[] = []
    for (const file of FILES) {
      const path = join(dir, file)
      if (!existsSync(path)) continue
      const values = parse(readFileSync(path, 'utf8')).get(key) ?? []
      if (values.some((value) => !off.includes(value))) seen.push(`apps/web/${file}`)
    }
    const fromEnv = env[key]
    // Bun may have put a file's value here, so only say "the environment" when no file did.
    if (fromEnv !== undefined && !off.includes(fromEnv) && seen.length === 0) {
      seen.push('the environment this deploy runs in')
    }
    for (const source of seen) found.push({ key, source, why })
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

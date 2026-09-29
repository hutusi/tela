/**
 * Writes the e2e stack's Worker configs: tela-web as `vite build` emitted it, tela-api and
 * tela-jobs as checked in, each with the test vars inlined. `wrangler dev` reads a secondary
 * Worker's vars from its own config directory, so one env file cannot reach all three, and
 * writing `.dev.vars` beside the real configs would clobber a developer's own.
 *
 *   bun apps/reader/e2e/stack.ts <outDir> <baseUrl>
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const [outDir = '.e2e-logs/reader', baseUrl = 'http://127.0.0.1:8811'] = process.argv.slice(2)
const root = resolve(import.meta.dir, '..', '..', '..')
const AUTH_SECRET = 'e2e-auth-secret-that-is-long-enough-for-hmac-signing'

/** JSON with comments, as wrangler reads it: comments outside strings go, trailing commas too. */
function parseJsonc(text: string): Record<string, unknown> {
  let out = ''
  let inString = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inString) {
      out += c
      if (c === '\\') out += text[++i] ?? ''
      else if (c === '"') inString = false
    } else if (c === '"') {
      inString = true
      out += c
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++
      out += '\n'
    } else if (c === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i + 2) + 1
    } else out += c
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'))
}

/** The parts of a Wrangler config this script changes. */
type Config = {
  main: string
  assets?: { directory?: string }
  d1_databases?: { migrations_dir?: string }[]
  vars?: Record<string, unknown>
  env?: unknown
  routes?: unknown
  configPath?: unknown
  userConfigPath?: unknown
}

/** The config at `path`, relocated to `outDir`: every relative path it names made absolute. */
function relocate(path: string, vars: Record<string, string>) {
  const config = parseJsonc(readFileSync(path, 'utf8')) as Config
  const dir = dirname(path)
  config.main = resolve(dir, config.main)
  if (config.assets?.directory) config.assets.directory = resolve(dir, config.assets.directory)
  for (const d1 of config.d1_databases ?? []) {
    if (d1.migrations_dir) d1.migrations_dir = resolve(dir, d1.migrations_dir)
  }
  // Gate G2's shadow environment has no business in a test run.
  delete config.env
  // A route makes `wrangler dev` present every request as tela.ainaive.com, and the edge then
  // refuses the suite's own writes from localhost as cross-origin.
  delete config.routes
  delete config.configPath
  delete config.userConfigPath
  config.vars = { ...config.vars, ...vars }
  return config
}

mkdirSync(outDir, { recursive: true })
const configs = {
  web: relocate(join(root, 'apps/reader/dist/tela_web/wrangler.json'), {
    AUTH_SECRET,
    TELA_PRIVATE_BETA: '1',
  }),
  api: relocate(join(root, 'apps/api/wrangler.jsonc'), {
    AUTH_SECRET,
    ADMIN_TOKEN: 'e2e-admin',
    ENV: 'test',
    PUBLIC_URL: baseUrl,
  }),
  jobs: relocate(join(root, 'apps/jobs/wrangler.jsonc'), {
    ENV: 'test',
    LLM_PROVIDER: 'mock',
    LLM_MOCK_DROP_MARKER: '[[drop]]',
    PUBLIC_URL: baseUrl,
    WEBSUB_ENABLED: '1',
  }),
}
for (const [name, config] of Object.entries(configs)) {
  writeFileSync(join(outDir, `${name}.wrangler.json`), `${JSON.stringify(config, null, 2)}\n`)
}

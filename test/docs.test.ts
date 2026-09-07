/**
 * The docs drift guard.
 *
 * AGENTS.md claims its repo map covers every workspace, README.md claims the same for its layout
 * table, and both point at files by path. `packages/ingest` was absent from both for eleven
 * modules' worth of history while AGENTS.md told agents to put worker logic there — nothing was
 * looking. This file looks.
 *
 * It reads files and asks git what it tracks: no database, no network. When a check
 * here fails, the fix is almost always to update the doc, not to loosen the check — these are
 * claims the docs make, and the point is that they stay true.
 */

import { describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8')
const exists = (rel: string) => {
  try {
    statSync(join(ROOT, rel))
    return true
  } catch {
    return false
  }
}
/**
 * A path a doc names is fine if git tracks it, or if git deliberately ignores it — the runbook
 * legitimately names files you create (`apps/web/.env`) and files a run generates
 * (`apps/web/test-results`). What it must not name is a path that is neither: that is a typo or a
 * file that moved.
 *
 * Asking the filesystem instead is what let this pass locally and fail in CI, because those two
 * exist on a machine that has run the app and not on a clean checkout.
 */
const TRACKED = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' })
  .split('\0')
  .filter(Boolean)
const TRACKED_SET = new Set(TRACKED)

/** Tracked as a file, or a directory holding one. */
const isTracked = (rel: string) =>
  TRACKED_SET.has(rel) || TRACKED.some((f) => f.startsWith(`${rel}/`))

/**
 * Matched by a .gitignore rule, so its absence from a checkout is intended. The path is tried with
 * a trailing slash too: a directory-only rule (`test-results/`) cannot match a path that is not
 * there to be seen as a directory, which is precisely the clean-checkout case this guards.
 */
const isIgnored = (rel: string) =>
  [rel, `${rel}/`].some((candidate) => {
    try {
      execFileSync('git', ['check-ignore', '-q', '--no-index', candidate], {
        cwd: ROOT,
        stdio: 'ignore',
      })
      return true
    } catch {
      return false
    }
  })

const known = (rel: string) => isTracked(rel) || isIgnored(rel)

const dirsIn = (rel: string) =>
  readdirSync(join(ROOT, rel), { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
    .map((e) => `${rel}/${e.name}`)

const AGENTS = read('AGENTS.md')
const README = read('README.md')
const OPERATIONS = read('docs/OPERATIONS.md')

/** Every workspace in the monorepo. */
const WORKSPACES = [...dirsIn('apps'), ...dirsIn('packages')].sort()

describe('workspace coverage', () => {
  it('finds every workspace on disk', () => {
    // A broken readdir would make every check below pass vacuously.
    expect(WORKSPACES.length).toBeGreaterThanOrEqual(7)
  })

  it.each(WORKSPACES)('%s is in the AGENTS.md repo map', (ws) => {
    expect(AGENTS).toContain(`\`${ws}\``)
  })

  it.each(WORKSPACES)('%s is in the README layout table', (ws) => {
    expect(README).toContain(`\`${ws}\``)
  })
})

/**
 * Paths the docs name in backticks or markdown links. Only prefixes that are unambiguously
 * repo-relative are checked; a bare `client.ts` in prose is not a claim about a location.
 */
const PATH_PREFIXES = ['apps/', 'packages/', 'docs/', 'supabase/', '.github/', 'test/']
const DOC_FILES = [
  'AGENTS.md',
  'README.md',
  'CHANGELOG.md',
  'docs/ARCHITECTURE.md',
  'docs/OPERATIONS.md',
  'docs/DESIGN.md',
]

function referencedPaths(source: string): string[] {
  const found = new Set<string>()
  // `packages/db/src/schema/*.ts` in code spans, and [text](docs/adr/) in links.
  const spans = source.match(/`[^`\n]+`/g) ?? []
  const links = (source.match(/\]\(([^)\s]+)\)/g) ?? []).map((m) => m.slice(2, -1))
  for (const raw of [...spans.map((s) => s.slice(1, -1)), ...links]) {
    const candidate = raw.trim().replace(/[.,;:]+$/, '')
    if (!PATH_PREFIXES.some((p) => candidate.startsWith(p))) continue
    // Skip globs and placeholders: `packages/db/src/schema/*.ts`, `apps/<name>/.env`.
    if (/[*<>{}|\s]/.test(candidate)) continue
    found.add(candidate.replace(/\/$/, ''))
  }
  return [...found]
}

describe('path references resolve', () => {
  const all = DOC_FILES.flatMap((f) => referencedPaths(read(f)).map((p) => [f, p] as const))

  it('extracts a plausible number of paths', () => {
    // Guards against a regex change that silently matches nothing.
    expect(all.length).toBeGreaterThan(40)
  })

  it.each(all)('%s references %s, which git tracks or ignores', (_doc, path) => {
    expect(known(path)).toBe(true)
  })
})

describe('worker roles are documented', () => {
  const roles = [...read('apps/worker/src/roles.ts').matchAll(/^\s{2}'([a-z]+)',$/gm)].map(
    (m) => m[1] as string,
  )

  it('reads the role list', () => {
    expect(roles).toContain('relay')
    expect(roles.length).toBeGreaterThanOrEqual(7)
  })

  it.each(roles)('%s is named in the README', (role) => {
    expect(README).toContain(role)
  })

  it.each(roles)('%s is named in the operations runbook', (role) => {
    expect(OPERATIONS).toContain(role)
  })
})

describe('root scripts are documented', () => {
  const scripts = Object.keys(
    (JSON.parse(read('package.json')) as { scripts: Record<string, string> }).scripts,
  )

  it('reads the script list', () => {
    expect(scripts.length).toBeGreaterThan(8)
  })

  it.each(scripts)('bun run %s appears in the AGENTS.md commands', (script) => {
    expect(AGENTS).toContain(`bun run ${script}`)
  })
})

describe('ADRs are well formed', () => {
  const files = readdirSync(join(ROOT, 'docs/adr'))
    .filter((f) => f.endsWith('.md'))
    .sort()

  it('numbers them sequentially from 0001, with no gaps', () => {
    expect(files.length).toBeGreaterThan(10)
    const numbers = files.map((f) => Number(f.slice(0, 4)))
    expect(numbers).toEqual(files.map((_, i) => i + 1))
  })

  it.each(files)('%s has a heading matching its filename and a status line', (file) => {
    const body = read(`docs/adr/${file}`)
    expect(body).toMatch(new RegExp(`^# ${file.slice(0, 4)} — `))
    expect(body).toMatch(/^Status: /m)
  })
})

describe('environment variables are documented', () => {
  /** Read by the runtime but not Tela's own configuration. */
  const ALLOWED = new Set(['NODE_ENV', 'CI', 'NEXTJS_ENV'])

  const sources = [...dirsIn('apps'), ...dirsIn('packages')].map((ws) => `${ws}/src`).filter(exists)

  function tsFiles(dir: string): string[] {
    return readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((e) => {
      const rel = `${dir}/${e.name}`
      if (e.isDirectory()) return tsFiles(rel)
      return e.name.endsWith('.ts') || e.name.endsWith('.tsx') ? [rel] : []
    })
  }

  const names = new Set<string>()
  for (const dir of sources) {
    for (const file of tsFiles(dir)) {
      for (const m of read(file).matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) {
        names.add(m[1] as string)
      }
    }
  }
  // The worker validates its environment through a zod schema rather than reading process.env
  // per key, so its names live in the schema object.
  const schema = read('apps/worker/src/config.ts')
  const schemaBody = schema.slice(schema.indexOf('const envSchema'), schema.indexOf('\n})'))
  for (const m of schemaBody.matchAll(/^ {2}([A-Z][A-Z0-9_]*):/gm)) names.add(m[1] as string)

  const documented = [...names].filter((n) => !ALLOWED.has(n)).sort()

  it('finds the environment variables the code reads', () => {
    expect(documented).toContain('DATABASE_URL')
    expect(documented).toContain('WORKER_ROLES')
    expect(documented.length).toBeGreaterThan(20)
  })

  it.each(documented)('%s is in the operations env table', (name) => {
    expect(OPERATIONS).toContain(`\`${name}\``)
  })
})

describe('the Node runtime is pinned consistently', () => {
  /**
   * AGENTS.md states that @types/node tracks the worker's runtime major. Types ahead of the
   * runtime are the dangerous direction: tsc accepts an API the deployed Node does not have, and
   * the failure lands in production. This is how it drifted once — @types/node ^26 against a
   * Node 22 runtime — so the pins are checked against each other rather than trusted.
   */
  const nodeVersion = read('.node-version').trim()
  const engines = (JSON.parse(read('package.json')) as { engines: { node: string } }).engines.node
  const dockerfile = read('apps/worker/Dockerfile')
  const workflow = read('.github/workflows/ci.yml')

  const major = Number(nodeVersion.split('.')[0])

  it('reads a plausible major from .node-version', () => {
    expect(Number.isInteger(major)).toBe(true)
    expect(major).toBeGreaterThanOrEqual(22)
  })

  it('agrees with the engines field', () => {
    // Exact, not substring: `<24` contains "24" while excluding Node 24 outright.
    expect(engines).toBe(`>=${major}`)
  })

  it("agrees with the worker image's runtime stage", () => {
    expect(dockerfile).toMatch(new RegExp(`FROM node:${major}[.\\-]`))
  })

  it('agrees with the node-version CI sets up', () => {
    expect(workflow).toMatch(new RegExp(`node-version: ${major}\\b`))
  })

  /**
   * Living docs describe the present, so any Node major but the pinned one is wrong — including a
   * newer one. Allowing newer was too lax: it would wave through a README that promoted the
   * prerequisite to Node 26 while the worker still ran 24, which is a live proposal, not a
   * hypothetical.
   *
   * A line that deliberately names another version — the runbook's dated plan to move after Node
   * 26 reaches LTS — opts out with a `node-pin:planned` marker, so the exemption is visible where
   * it applies rather than built into the rule. A constraint quoted from someone else
   * ("Node >= 22.12" for pg-boss) never matches: the regex needs a digit straight after "Node".
   *
   * CHANGELOG.md and the ADRs are excluded outright, being dated records whose job is to say what
   * was true then.
   */
  const LIVING_DOCS = DOC_FILES.filter((f) => f !== 'CHANGELOG.md')

  it.each(LIVING_DOCS)('%s names only the pinned Node major', (doc) => {
    const wrong = read(doc)
      .split('\n')
      .filter((line) => !line.includes('node-pin:planned'))
      .flatMap((line) => [...line.matchAll(/Node(?:\.js)? (\d+)/g)].map((m) => Number(m[1])))
      .filter((v) => v !== major)
    expect([...new Set(wrong)]).toEqual([])
  })

  it.each(
    [...dirsIn('apps'), ...dirsIn('packages'), '.']
      .map((ws) => (ws === '.' ? 'package.json' : `${ws}/package.json`))
      .filter(exists)
      .flatMap((p) => {
        const pkg = JSON.parse(read(p)) as {
          dependencies?: Record<string, string>
          devDependencies?: Record<string, string>
        }
        const range = pkg.dependencies?.['@types/node'] ?? pkg.devDependencies?.['@types/node']
        return range ? [[p, range] as const] : []
      }),
  )('%s pins @types/node to the runtime major (%s)', (_pkg, range) => {
    // Exact caret, not "starts with the right digits": `>=24` also admits Node 26 types, which is
    // the drift this whole block exists to prevent.
    expect(range).toBe(`^${major}`)
  })
})

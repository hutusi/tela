/**
 * `bun run dev:seed [email]`: a local database worth opening the admin console on (ADR 0039).
 * With `bun run dev` running, it adds the curated blogs and runs the sweeps so they have posts,
 * then writes the states an operator acts on (`dev-seed-data.ts`) into the same local D1, once.
 * Given an address, it also invites it, opens the console to it, and prints its sign-in link.
 *
 * Local only, by construction: it talks to a localhost dev server, and writes with
 * `wrangler d1 execute --local` into the state `bun run dev` keeps. Production is never touched.
 *
 *   bun run dev:seed
 *   bun run dev:seed you@example.com
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CURATED_SITES, type CuratedSite } from './curated-sites'
import { SEED_MARKER, SEED_MIN_SITES, type SeedSite, seedStatements } from './dev-seed-data'

const ROOT = fileURLToPath(new URL('../../..', import.meta.url))
const WRANGLER = join(ROOT, 'apps/reader/node_modules/.bin/wrangler')
const STATE = join(ROOT, 'apps/reader/.wrangler/state')
const API_CONFIG = join(ROOT, 'apps/api/wrangler.jsonc')

const base = (process.env.TELA_URL ?? 'http://localhost:5173').replace(/\/$/, '')
const email = process.argv[2]

function stop(message: string): never {
  console.error(message)
  process.exit(1)
}

if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(base)) {
  stop(`dev:seed only seeds a local dev server; ${base} is not one`)
}

/** The local ADMIN_TOKEN, from the environment or `apps/api/.dev.vars` (OPERATIONS.md). */
function adminToken(): string {
  if (process.env.ADMIN_TOKEN) return process.env.ADMIN_TOKEN
  try {
    const vars = readFileSync(join(ROOT, 'apps/api/.dev.vars'), 'utf8')
    const token = vars.match(/^ADMIN_TOKEN=(.+)$/m)?.[1]?.trim()
    if (token) return token
  } catch {}
  return stop('no ADMIN_TOKEN: set it, or write apps/api/.dev.vars as OPERATIONS.md says')
}
const token = adminToken()
const headers = { origin: base, 'content-type': 'application/json' }

async function call(path: string, body?: unknown, operator = false) {
  const res = await fetch(`${base}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: operator ? { ...headers, authorization: `Bearer ${token}` } : headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { res, json: (await res.json().catch(() => null)) as unknown }
}

/** One statement's rows from the local D1, through wrangler. */
function query<T>(statement: string): T[] {
  const out = execFileSync(
    WRANGLER,
    [
      'd1',
      'execute',
      'tela',
      '--local',
      '--persist-to',
      STATE,
      '-c',
      API_CONFIG,
      '--json',
      '--command',
      statement,
    ],
    { encoding: 'utf8', cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  return ((JSON.parse(out) as { results: T[] }[])[0]?.results ?? []) as T[]
}

const up = await fetch(`${base}/api/health`).catch(() => null)
if (!up?.ok) stop(`no dev server at ${base}: start \`bun run dev\` first (OPERATIONS.md)`)

console.log(`adding the ${CURATED_SITES.length} curated blogs…`)
for (const site of CURATED_SITES as readonly CuratedSite[]) {
  const { res } = await call(
    '/api/admin/curate',
    {
      feedUrl: site.feedUrl,
      topics: site.topics,
      featured: site.featured === true,
      title: site.title,
    },
    true,
  )
  if (!res.ok) console.warn(`  ✗ ${site.feedUrl}: ${res.status}`)
}
console.log('running the sweeps (fetches, titles), a minute or two…')
for (let i = 0; i < 2; i++) await call('/api/test/cycle?refetch=0', {})

let actor: string | null = null
if (email) {
  const invited = await call('/api/admin/invite', { email }, true)
  if (!invited.res.ok) stop(`could not invite ${email}: ${invited.res.status}`)
  actor = (invited.json as { userId: string }).userId
  await call('/api/admin/admins', { email, admin: true }, true)
}

if (query<{ id: string }>(`select id from user where id = '${SEED_MARKER}'`).length > 0) {
  console.log('the seed is already in this database; nothing written twice')
} else {
  const sites = query<SeedSite>(`select s.id, s.home_url as homeUrl, min(f.id) as feedId
    from sites s join feeds f on f.site_id = s.id and f.merged_into is null
    group by s.id order by s.id`)
  if (sites.length < SEED_MIN_SITES) {
    stop(
      `only ${sites.length} blogs could be added (the seed needs ${SEED_MIN_SITES}): is this machine online?`,
    )
  }
  const dir = mkdtempSync(join(tmpdir(), 'tela-seed-'))
  try {
    const file = join(dir, 'seed.sql')
    writeFileSync(file, `${seedStatements({ now: Date.now(), sites, actor }).join('\n')}\n`)
    execFileSync(
      WRANGLER,
      ['d1', 'execute', 'tela', '--local', '--persist-to', STATE, '-c', API_CONFIG, '--file', file],
      { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'] },
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  console.log('seeded: members, codes, claims, feeds in trouble, a month of spend, dead letters')
}

if (email) {
  const { json } = await call(`/api/test/outbox?email=${encodeURIComponent(email.toLowerCase())}`)
  const mail = (json as { text: string }[] | null)?.at(-1)
  const link = mail?.text.match(/(http\S+\/login\?\S+)/)?.[1]
  console.log(
    link ? `sign in as ${email}: ${link}` : `${email} can open ${base}/admin once signed in`,
  )
} else {
  console.log(`open ${base}/admin as an admin (\`bun run dev:seed you@example.com\` makes one)`)
}

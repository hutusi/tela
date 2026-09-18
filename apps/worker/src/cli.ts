/**
 * One-off ingestion and repair commands against DATABASE_URL. Fetch can run before pg-boss;
 * repair-titles requires its queue.
 *   bun run src/cli.ts discover <url>
 *   bun run src/cli.ts fetch <feedUrl>       # ensureFeed + fetchFeed
 *   bun run src/cli.ts extract <articleId>
 *   bun run src/cli.ts repair-titles [limit]
 *   bun run src/cli.ts seed-discover [--dry-run] [--limit N] [--skip N] [--only <match>]
 */
import { createDb } from '@tela/db'
import { discoverFeeds, ensureFeed, fetchFeed } from '@tela/ingest'
import { extractArticleContent } from '@tela/ingest/extract'
import { loadConfig } from './config'
import { createHttp, createOutboundFetch } from './context'
import { CURATED_SITES } from './seed/curated-sites'
import { seedDiscover } from './seed/seed-discover'
import {
  DEFAULT_TITLE_REPAIR_LIMIT,
  MAX_TITLE_REPAIR_LIMIT,
  repairMissingTitleJobs,
  titleEnqueuer,
  titleQueueAvailable,
} from './title-jobs'

const USAGE =
  'usage: cli.ts <discover|fetch|extract> <url|id> | cli.ts repair-titles [limit]\n' +
  '     | cli.ts seed-discover [--dry-run] [--limit N] [--skip N] [--only <match>]'

const VALUE_FLAGS = new Set(['limit', 'skip', 'only'])

function usage(message?: string): never {
  if (message) console.error(message)
  console.error(USAGE)
  process.exit(2)
}

/** Positionals and flags, kept minimal: `--flag`, `--flag value`, `--flag=value`. */
function parseArgs(argv: string[]) {
  const positionals: string[] = []
  const flags = new Map<string, string | true>()
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] as string
    if (!token.startsWith('--')) {
      positionals.push(token)
      continue
    }
    const [name, inline] = token.slice(2).split(/=(.*)/s, 2)
    if (!name) usage(`bad flag ${token}`)
    if (!VALUE_FLAGS.has(name)) {
      if (inline !== undefined) usage(`flag --${name} takes no value`)
      flags.set(name, true)
      continue
    }
    const value = inline ?? argv[++i]
    if (value === undefined) usage(`flag --${name} needs a value`)
    flags.set(name, value)
  }
  return { positionals, flags }
}

function intFlag(value: string | true | undefined, name: string, max: number): number | undefined {
  if (value === undefined) return undefined
  const n = Number(value)
  if (value === true || !Number.isInteger(n) || n < 1 || n > max) {
    usage(`--${name} must be an integer from 1 to ${max}`)
  }
  return n
}

const { positionals, flags } = parseArgs(process.argv.slice(2))
const [command, arg, ...extra] = positionals
const config = loadConfig({ ...process.env, WORKER_ROLES: 'fetch' })
const http = createHttp(config, createOutboundFetch())

const KNOWN = ['discover', 'fetch', 'extract', 'repair-titles', 'seed-discover']
if (!command || !KNOWN.includes(command)) usage(command ? `unknown command ${command}` : undefined)
if (extra.length > 0) usage(`${command} takes at most one argument`)

const seeding = command === 'seed-discover'
const takesArg = command === 'discover' || command === 'fetch' || command === 'extract'
if (takesArg && !arg) usage(`${command} needs an argument`)
if (!takesArg && !seeding && flags.size > 0) usage(`${command} takes no flags`)
if (seeding) {
  if (arg) usage('seed-discover takes no positional argument')
  for (const name of flags.keys()) {
    if (!['dry-run', 'limit', 'skip', 'only'].includes(name)) usage(`unknown flag --${name}`)
  }
}

if (command === 'discover') {
  const found = await discoverFeeds(http, arg as string)
  console.log(JSON.stringify(found, null, 2))
  process.exit(0)
}

const db = createDb(config.DATABASE_URL as string, { max: 2 })
try {
  if (command === 'fetch') {
    const ensured = await ensureFeed(db, { feedUrl: arg as string })
    // Title jobs are the fetch job's doing, not fetchFeed's, so a hand-run fetch that forgets
    // them seeds articles no reader ever sees translated and nothing retries.
    const titles = { articles: 0, jobs: 0 }
    const titlesAvailable = await titleQueueAvailable(db)
    if (!titlesAvailable) {
      console.warn('queue translate.title does not exist; seeding without title jobs')
    }
    const result = await fetchFeed(db, http, ensured.feedId, {
      ...(titlesAvailable ? { onArticleStored: titleEnqueuer(titles) } : {}),
    })
    console.log(JSON.stringify({ ...ensured, ...result, titleJobs: titles.jobs }, null, 2))
  } else if (command === 'extract') {
    const result = await extractArticleContent(db, http, Number(arg))
    console.log(JSON.stringify(result, null, 2))
  } else if (seeding) {
    const limit = intFlag(flags.get('limit'), 'limit', CURATED_SITES.length)
    const skip = intFlag(flags.get('skip'), 'skip', CURATED_SITES.length)
    const only = flags.get('only')
    if (only === true) usage('--only needs a value')
    const result = await seedDiscover(db, http, CURATED_SITES, {
      ...(flags.has('dry-run') ? { dryRun: true } : {}),
      ...(limit === undefined ? {} : { limit }),
      ...(skip === undefined ? {} : { skip }),
      ...(only === undefined ? {} : { only }),
      // Progress goes to stderr as it happens, so a long run is watchable and a crash still
      // leaves a trail of what was done.
      onEntry: (r) =>
        console.error(
          `${r.outcome.padEnd(9)} ${r.feedUrl}` +
            ` — ${r.fetch}, ${r.articles} articles, ${r.titleJobs} title jobs` +
            `${r.curated ? `, ${r.listing}` : ''}${r.reason ? ` (${r.reason})` : ''}` +
            `${r.error ? `: ${r.error}` : ''}`,
        ),
    })
    if (result.titleQueue === 'missing' && !flags.has('dry-run')) {
      console.warn('queue translate.title does not exist; seeded without title jobs')
    }
    console.log(JSON.stringify(result, null, 2))
    if (result.totals.errors > 0) process.exitCode = 1
  } else {
    const limit = arg === undefined ? DEFAULT_TITLE_REPAIR_LIMIT : Number(arg)
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_TITLE_REPAIR_LIMIT) {
      console.error(`repair-titles limit must be an integer from 1 to ${MAX_TITLE_REPAIR_LIMIT}`)
      process.exitCode = 2
    } else {
      const result = await repairMissingTitleJobs(db, limit)
      console.log(JSON.stringify({ command: 'repair-titles', limit, ...result }, null, 2))
    }
  }
} finally {
  await db.close()
}

/**
 * Operator commands against a running tela-api, over the public origin with the admin token, so
 * D1 credentials never leave Cloudflare (ADR 0024).
 *
 *   ADMIN_TOKEN=… bun run admin invite reader@example.com
 *   ADMIN_TOKEN=… bun run admin code WELCOME --uses 20   # an invite code of your own (ADR 0034)
 *   ADMIN_TOKEN=… bun run admin codes                    # yours, with their places and holds
 *   ADMIN_TOKEN=… bun run admin revoke WELCOME           # nobody else joins with it
 *   ADMIN_TOKEN=… bun run admin curate                   # the curated blogs (curated-sites.ts)
 *   ADMIN_TOKEN=… bun run admin grant you@example.com    # open the admin console to a member
 *   ADMIN_TOKEN=… bun run admin ungrant you@example.com  # and close it (ADR 0039)
 *   TELA_URL=http://localhost:8787 ADMIN_TOKEN=… bun run admin invite a@b.c
 */
import { parseArgs } from 'node:util'
import { CURATED_SITES } from './curated-sites'

const [command, ...args] = process.argv.slice(2)
const base = (process.env.TELA_URL ?? 'https://tela.ainaive.com').replace(/\/$/, '')
const token = process.env.ADMIN_TOKEN

function usage(): never {
  console.error(
    [
      'usage: bun run admin invite <email>',
      '       bun run admin code <TEXT> [--uses N]',
      '       bun run admin codes',
      '       bun run admin revoke <TEXT>',
      '       bun run admin curate',
      '       bun run admin grant|ungrant <email>',
      '(needs ADMIN_TOKEN; TELA_URL optional)',
    ].join('\n'),
  )
  process.exit(2)
}

/** One call to `/api/admin/*`: its status, and its body read as JSON (empty when it is not). */
async function admin(method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}/api/admin/${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await res.text()
  let json: Record<string, unknown> = {}
  try {
    json = JSON.parse(text) as Record<string, unknown>
  } catch {}
  return { res, text, json }
}

/** Say why a call failed, and stop. */
function failed(what: string, res: Response, text: string): never {
  console.error(`${what} failed: ${res.status} ${text.slice(0, 200)}`)
  process.exit(1)
}

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10)

if (!token) usage()
if (command === 'invite') {
  const email = args[0]
  if (!email) usage()
  const { res, text, json } = await admin('POST', 'invite', { email })
  if (!res.ok) failed('invite', res, text)
  console.log(
    json.created
      ? `invited ${email}; a code is on its way`
      : `${email} already has an account; mailed a fresh code`,
  )
} else if (command === 'code') {
  // `--uses N` or `--uses=N`, before the text or after it, and exactly one text: anything else is
  // refused rather than guessed at, since a misread argument would make a live code nobody meant.
  let parsed: { values: { uses?: string | undefined }; positionals: string[] }
  try {
    parsed = parseArgs({
      args,
      options: { uses: { type: 'string' } },
      allowPositionals: true,
      strict: true,
    })
  } catch {
    usage()
  }
  const [text, ...stray] = parsed.positionals
  const uses = parsed.values.uses === undefined ? 1 : Number(parsed.values.uses)
  if (!text || text.startsWith('-') || stray.length > 0) usage()
  if (!Number.isInteger(uses) || uses < 1) usage()
  const { res, text: answer, json } = await admin('POST', 'codes', { code: text, uses })
  if (json.error === 'invalid_code') {
    console.error(`a code is 4 to 32 letters and digits (spaces and dashes are dropped)`)
    process.exit(1)
  }
  if (json.error === 'member_shaped') {
    console.error(`${text} has the shape of a member's code (12 of their symbols); choose another`)
    process.exit(1)
  }
  if (json.error === 'code_exists') {
    console.error(`${text} is a code already; \`bun run admin codes\` lists yours`)
    process.exit(1)
  }
  if (!res.ok) failed('code', res, answer)
  console.log(
    `made ${json.code} for ${json.maxUses} ${json.maxUses === 1 ? 'person' : 'people'}: ${base}/join?code=${json.code}`,
  )
} else if (command === 'codes') {
  const { res, text, json } = await admin('GET', 'codes')
  if (!res.ok) failed('codes', res, text)
  const codes = json.codes as {
    code: string
    maxUses: number
    uses: number
    holds: number
    createdAt: number
    revokedAt: number | null
  }[]
  if (codes.length === 0) console.log('no codes yet: bun run admin code <TEXT> --uses N')
  for (const c of codes) {
    console.log(
      [
        c.code.padEnd(32),
        `${c.uses}/${c.maxUses} joined`,
        `${c.holds} waiting`,
        `made ${day(c.createdAt)}`,
        c.revokedAt === null ? '' : `revoked ${day(c.revokedAt)}`,
      ]
        .join('  ')
        .trimEnd(),
    )
  }
} else if (command === 'revoke') {
  const text = args[0]
  if (!text) usage()
  const { res, text: answer } = await admin('DELETE', `codes/${encodeURIComponent(text)}`)
  if (res.status === 404) {
    console.error(`${text} is not a code of yours that can still be revoked`)
    process.exit(1)
  }
  if (!res.ok) failed('revoke', res, answer)
  console.log(`revoked ${text}; those who joined with it keep their accounts`)
} else if (command === 'curate') {
  // One blog a request: each fetches the feed, so the list takes a while, and one that fails
  // does not stop the rest. Running it again changes nothing that is already right.
  let failures = 0
  for (const site of CURATED_SITES) {
    const { res, json } = await admin('POST', 'curate', {
      feedUrl: site.feedUrl,
      topics: site.topics,
    })
    const body = json as { error?: string; created?: boolean; listing?: string; topics?: string[] }
    if (!res.ok) {
      failures++
      console.error(`✗ ${site.feedUrl}: ${body.error ?? res.status}`)
      continue
    }
    console.log(
      `${body.created ? '+' : '='} ${site.feedUrl}: ${body.listing}, ${body.topics?.join(' ')}`,
    )
  }
  console.log(
    `${CURATED_SITES.length - failures} of ${CURATED_SITES.length} curated; the sweeps fetch new ones within a minute`,
  )
  if (failures > 0) process.exit(1)
} else if (command === 'grant' || command === 'ungrant') {
  const email = args[0]
  if (!email) usage()
  const admin_ = command === 'grant'
  const { res, text, json } = await admin('POST', 'admins', { email, admin: admin_ })
  if (res.status === 404) {
    console.error(`${email} has no account; \`bun run admin invite ${email}\` makes one`)
    process.exit(1)
  }
  if (!res.ok) failed(command, res, text)
  const verb = admin_ ? 'can now open' : 'can no longer open'
  console.log(
    json.changed
      ? `${email} ${verb} the admin console (${base}/admin)`
      : `${email} already ${admin_ ? 'could' : 'could not'} open the admin console`,
  )
} else {
  usage()
}

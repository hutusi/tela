/**
 * Operator commands against a running tela-api, over the public origin with the admin token, so
 * D1 credentials never leave Cloudflare (ADR 0024).
 *
 *   ADMIN_TOKEN=… bun run admin invite reader@example.com
 *   ADMIN_TOKEN=… bun run admin curate        # add and feature the curated blogs (curated-sites.ts)
 *   TELA_URL=http://localhost:8787 ADMIN_TOKEN=… bun run admin invite a@b.c
 */
import { CURATED_SITES } from './curated-sites'

const [command, ...args] = process.argv.slice(2)
const base = (process.env.TELA_URL ?? 'https://tela.ainaive.com').replace(/\/$/, '')
const token = process.env.ADMIN_TOKEN

function usage(): never {
  console.error(
    'usage: bun run admin invite <email> | curate   (needs ADMIN_TOKEN; TELA_URL optional)',
  )
  process.exit(2)
}

if (!token) usage()
if (command === 'invite') {
  const email = args[0]
  if (!email) usage()
  const res = await fetch(`${base}/api/admin/invite`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ email }),
  })
  const body = await res.text()
  if (!res.ok) {
    console.error(`invite failed: ${res.status} ${body.slice(0, 200)}`)
    process.exit(1)
  }
  const { created } = JSON.parse(body) as { created: boolean }
  console.log(
    created
      ? `invited ${email}; a code is on its way`
      : `${email} already has an account; mailed a fresh code`,
  )
} else if (command === 'curate') {
  // One blog a request: each fetches the feed, so the list takes a while, and one that fails
  // does not stop the rest. Running it again changes nothing that is already right.
  let failed = 0
  for (const site of CURATED_SITES) {
    const res = await fetch(`${base}/api/admin/curate`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ feedUrl: site.feedUrl, topics: site.topics }),
    })
    const body = (await res.json().catch(() => ({}))) as {
      error?: string
      created?: boolean
      listing?: string
      topics?: string[]
    }
    if (!res.ok) {
      failed++
      console.error(`✗ ${site.feedUrl}: ${body.error ?? res.status}`)
      continue
    }
    console.log(
      `${body.created ? '+' : '='} ${site.feedUrl}: ${body.listing}, ${body.topics?.join(' ')}`,
    )
  }
  console.log(
    `${CURATED_SITES.length - failed} of ${CURATED_SITES.length} curated; the sweeps fetch new ones within a minute`,
  )
  if (failed > 0) process.exit(1)
} else {
  usage()
}

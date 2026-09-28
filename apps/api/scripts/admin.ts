/**
 * Operator commands against a running tela-api, over the public origin with the admin token, so
 * D1 credentials never leave Cloudflare (ADR 0024).
 *
 *   ADMIN_TOKEN=… bun run admin invite reader@example.com
 *   TELA_URL=http://localhost:8787 ADMIN_TOKEN=… bun run admin invite a@b.c
 */
const [command, ...args] = process.argv.slice(2)
const base = (process.env.TELA_URL ?? 'https://tela.ainaive.com').replace(/\/$/, '')
const token = process.env.ADMIN_TOKEN

function usage(): never {
  console.error('usage: bun run admin invite <email>   (needs ADMIN_TOKEN; TELA_URL optional)')
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
} else {
  usage()
}

export {}

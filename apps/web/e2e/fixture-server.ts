/**
 * Serves captured feeds and a page that declares one, for e2e runs.
 *   bun run e2e/fixture-server.ts [port]
 */
import { createHmac, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'

const port = Number(process.argv[2] ?? process.env.E2E_FIXTURE_PORT ?? 4790)
const feeds = join(import.meta.dir, '..', '..', '..', 'packages', 'content', 'fixtures', 'feeds')

// A 1x1 transparent PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
)

/** Set by the e2e test through POST /__claim-token?token=…; rendered on the home page. */
let claimToken = ''

/**
 * A minimal WebSub hub: records subscription requests, verifies the callback's intent the way a
 * real hub would, and (on request from the test) sends a signed content ping.
 */
type HubSubscription = {
  mode: string
  topic: string
  callback: string
  secret: string
  leaseSeconds: number
  verifyStatus: number | null
  verified: boolean
}
const hubSubscriptions: HubSubscription[] = []

async function verifyIntent(sub: HubSubscription) {
  const challenge = randomBytes(8).toString('hex')
  const url = new URL(sub.callback)
  url.searchParams.set('hub.mode', sub.mode)
  url.searchParams.set('hub.topic', sub.topic)
  url.searchParams.set('hub.challenge', challenge)
  url.searchParams.set('hub.lease_seconds', String(sub.leaseSeconds))
  try {
    const res = await fetch(url)
    sub.verifyStatus = res.status
    sub.verified = res.status === 200 && (await res.text()) === challenge
  } catch {
    sub.verifyStatus = -1
  }
}

async function notify(sub: HubSubscription): Promise<number> {
  const body = '<feed><entry><title>pushed</title></entry></feed>'
  const signature = `sha256=${createHmac('sha256', sub.secret).update(body).digest('hex')}`
  const res = await fetch(sub.callback, {
    method: 'POST',
    headers: { 'content-type': 'application/atom+xml', 'x-hub-signature': signature },
    body,
  })
  return res.status
}

function readBody(req: import('node:http').IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = ''
    req.on('data', (c) => {
      data += c
    })
    req.on('end', () => resolve(data))
  })
}

const routes: Record<string, () => { body: Buffer | string; type: string }> = {
  '/': () => ({
    body: `<html><head><title>Fixture blog</title>
      <link rel="alternate" type="application/rss+xml" title="Fixture RSS" href="/jnito.xml">
      <link rel="icon" href="/pixel.png">
      ${claimToken ? `<meta name="tela-site-verification" content="${claimToken}">` : ''}
      </head><body><h1>Fixture blog home</h1></body></html>`,
    type: 'text/html; charset=utf-8',
  }),
  '/hutusi.xml': () => ({
    body: readFileSync(join(feeds, 'hutusi.rss.xml')),
    type: 'application/xml; charset=utf-8',
  }),
  '/jvns.xml': () => ({
    body: readFileSync(join(feeds, 'jvns.atom.xml')),
    type: 'application/xml; charset=utf-8',
  }),
  '/jnito.xml': () => ({
    body: readFileSync(join(feeds, 'jnito.rss.xml')),
    type: 'application/xml; charset=utf-8',
  }),
  // The Atom fixture with a hub link, so the worker subscribes at this server's /hub.
  '/hubbed.xml': () => ({
    body: readFileSync(join(feeds, 'jvns.atom.xml'), 'utf8').replace(
      /<feed([^>]*)>/,
      `<feed$1><link rel="hub" href="http://127.0.0.1:${port}/hub"/>`,
    ),
    type: 'application/atom+xml; charset=utf-8',
  }),
  '/blog': () => ({
    body: `<html><head><title>Fixture blog</title>
      <link rel="alternate" type="application/rss+xml" title="Fixture RSS" href="/jnito.xml"></head>
      <body><h1>Fixture blog</h1></body></html>`,
    type: 'text/html; charset=utf-8',
  }),
  '/pixel.png': () => ({ body: PNG, type: 'image/png' }),
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x')
  const path = url.pathname
  if (req.method === 'POST' && path === '/__claim-token') {
    claimToken = url.searchParams.get('token') ?? ''
    res.writeHead(204)
    res.end()
    return
  }
  if (req.method === 'POST' && path === '/hub') {
    const form = new URLSearchParams(await readBody(req))
    const sub: HubSubscription = {
      mode: form.get('hub.mode') ?? '',
      topic: form.get('hub.topic') ?? '',
      callback: form.get('hub.callback') ?? '',
      secret: form.get('hub.secret') ?? '',
      leaseSeconds: Number(form.get('hub.lease_seconds') ?? 0),
      verifyStatus: null,
      verified: false,
    }
    hubSubscriptions.push(sub)
    res.writeHead(202)
    res.end()
    setTimeout(() => void verifyIntent(sub), 100)
    return
  }
  if (req.method === 'GET' && path === '/__hub') {
    const json = JSON.stringify({
      subscriptions: hubSubscriptions.map(({ secret: _secret, ...s }) => s),
    })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(json)
    return
  }
  if (req.method === 'POST' && path === '/__hub/notify') {
    const sub = hubSubscriptions[Number(url.searchParams.get('i') ?? -1)]
    const status = sub ? await notify(sub) : 404
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ status }))
    return
  }
  const route = routes[path]
  if (!route) {
    res.writeHead(404)
    res.end('not found')
    return
  }
  const { body, type } = route()
  res.writeHead(200, { 'content-type': type, 'content-length': Buffer.byteLength(body) })
  res.end(body)
}).listen(port, '127.0.0.1', () => {
  console.log(`fixture server on http://127.0.0.1:${port}`)
})

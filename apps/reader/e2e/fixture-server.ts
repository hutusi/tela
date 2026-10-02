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

/** Whether every address has a Gravatar; off until a spec turns it on (POST /__gravatar?on=1). */
let gravatars = false

/** Set by the e2e test through POST /__claim-token?token=…; rendered on the home page. */
let claimToken = ''

/**
 * A full-content feed whose one post the highlight spec edits (POST /__changing?v=…): v1 is the
 * post as first read, v2 adds a paragraph before and words around the highlighted passage, v3
 * rewrites it so the passage is gone.
 */
let changing = 1
const CHANGING: Record<number, string[]> = {
  1: [
    'The first paragraph sets the scene for everything that follows.',
    'Tending a garden teaches patience more than any book about patience ever could.',
    'The last paragraph says goodbye.',
  ],
  2: [
    'An update, added later, now opens the post.',
    'The first paragraph sets the scene for everything that follows.',
    'In short: tending a garden teaches patience more than any book about patience ever could, as it turns out.',
    'The last paragraph says goodbye.',
  ],
  3: [
    'The first paragraph sets the scene.',
    'Something else entirely now.',
    'The last paragraph says goodbye.',
  ],
}

/**
 * Captured feeds declare their real home; served from here, that would make the worker move
 * their site to the real origin and point claim verification at it. Declare this server as
 * the home instead, so every fixture feed belongs to one site on this origin.
 */
const origin = `http://127.0.0.1:${port}/`
function servedFromHere(xml: string, realHome: string): string {
  return xml
    .replace(`<link>${realHome}</link>`, `<link>${origin}</link>`)
    .replace(`<link href="${realHome}"/>`, `<link href="${origin}"/>`)
}

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
    body: servedFromHere(readFileSync(join(feeds, 'hutusi.rss.xml'), 'utf8'), 'https://hutusi.com'),
    type: 'application/xml; charset=utf-8',
  }),
  '/jvns.xml': () => ({
    body: servedFromHere(readFileSync(join(feeds, 'jvns.atom.xml'), 'utf8'), 'https://jvns.ca'),
    type: 'application/xml; charset=utf-8',
  }),
  '/jnito.xml': () => ({
    body: servedFromHere(
      readFileSync(join(feeds, 'jnito.rss.xml'), 'utf8'),
      'https://blog.jnito.com/',
    ),
    type: 'application/xml; charset=utf-8',
  }),
  // The Atom fixture with a hub link, so the worker subscribes at this server's /hub.
  '/hubbed.xml': () => ({
    body: servedFromHere(
      readFileSync(join(feeds, 'jvns.atom.xml'), 'utf8'),
      'https://jvns.ca',
    ).replace(/<feed([^>]*)>/, `<feed$1><link rel="hub" href="http://127.0.0.1:${port}/hub"/>`),
    type: 'application/atom+xml; charset=utf-8',
  }),
  '/blog': () => ({
    body: `<html><head><title>Fixture blog</title>
      <link rel="alternate" type="application/rss+xml" title="Fixture RSS" href="/jnito.xml"></head>
      <body><h1>Fixture blog</h1></body></html>`,
    type: 'text/html; charset=utf-8',
  }),
  '/pixel.png': () => ({ body: PNG, type: 'image/png' }),
  // A summary-only feed (descriptions, no content) whose posts are full pages on this server.
  /**
   * A Japanese feed with one post whose middle paragraph the mock translator is told to drop
   * (LLM_MOCK_DROP_MARKER), so the body lands as `partial` — the one translation state no
   * captured feed produces, and the state the "not translated" mark exists for. Dated 2020 so
   * it sorts below every other fixture and no other spec picks it up by accident.
   */
  '/partial.xml': () => ({
    body: `<?xml version="1.0"?><rss version="2.0"><channel><title>Partial Fixture</title>
      <link>http://127.0.0.1:${port}/partial</link><language>ja</language>
      <item><guid>partial-1</guid><link>http://127.0.0.1:${port}/partial/posts/1</link>
        <title>部分的に翻訳された記事</title>
        <pubDate>Tue, 07 Jan 2020 08:00:00 GMT</pubDate>
        <description><![CDATA[<p>最初の段落はふつうに翻訳されます。</p>
          <p>この段落は [[drop]] 翻訳されません。</p>
          <p>最後の段落もふつうに翻訳されます。</p>]]></description></item>
      </channel></rss>`,
    type: 'application/rss+xml; charset=utf-8',
  }),

  '/changing.xml': () => ({
    body: `<?xml version="1.0"?><rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">
      <channel><title>Changing Fixture</title><link>http://127.0.0.1:${port}/changing</link><language>en</language>
      <item><guid>changing-1</guid><link>http://127.0.0.1:${port}/changing/posts/1</link>
        <title>A post that changes</title><pubDate>Mon, 07 Sep 2026 08:00:00 GMT</pubDate>
        <content:encoded><![CDATA[${(CHANGING[changing] ?? []).map((p) => `<p>${p}</p>`).join('')}]]></content:encoded>
      </item></channel></rss>`,
    type: 'application/rss+xml; charset=utf-8',
  }),
  '/summary.xml': () => ({
    body: `<?xml version="1.0"?><rss version="2.0"><channel><title>Summary Fixture</title>
      <link>http://127.0.0.1:${port}/summary</link><language>en</language>
      ${[1, 2, 3]
        .map(
          (
            n,
          ) => `<item><guid>summary-${n}</guid><link>http://127.0.0.1:${port}/summary/posts/${n}</link>
        <title>Summary post ${n}</title><description>Only a teaser for post ${n}.</description>
        <pubDate>Thu, 0${n} Sep 2026 08:00:00 GMT</pubDate></item>`,
        )
        .join('')}
      </channel></rss>`,
    type: 'application/rss+xml; charset=utf-8',
  }),
  '/summary': () => ({
    body: `<html><head><title>Summary fixture</title>
      <link rel="alternate" type="application/rss+xml" href="/summary.xml"></head>
      <body><h1>Summary fixture</h1></body></html>`,
    type: 'text/html; charset=utf-8',
  }),
  ...Object.fromEntries(
    [1, 2, 3].map((n) => [
      `/summary/posts/${n}`,
      () => ({
        body: `<html><head><title>Summary post ${n}</title></head><body><nav><a href="/">Home</a></nav>
          <article><h1>Summary post ${n}</h1>${Array.from(
            { length: 8 },
            (_, i) =>
              `<p>Full paragraph ${i + 1} of post ${n}. The quick brown fox jumps over the lazy dog while the reader finally gets the whole story instead of a teaser, sentence after sentence.</p>`,
          ).join('')}</article></body></html>`,
        type: 'text/html; charset=utf-8',
      }),
    ]),
  ),
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x')
  const path = url.pathname
  if (req.method === 'POST' && path === '/__changing') {
    changing = Number(url.searchParams.get('v') ?? 1)
    res.writeHead(204)
    res.end()
    return
  }
  // Stands in for gravatar.com (GRAVATAR_URL for tela-api and tela-jobs in the e2e). Nobody has a
  // picture until a spec says so (POST /__gravatar?on=1), so every other spec sees the letter.
  if (req.method === 'POST' && path === '/__gravatar') {
    gravatars = url.searchParams.get('on') === '1'
    res.writeHead(204)
    res.end()
    return
  }
  if (req.method === 'GET' && /^\/gravatar\/[0-9a-f]{64}$/.test(path)) {
    if (!gravatars) {
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('no picture')
      return
    }
    res.writeHead(200, { 'content-type': 'image/png' })
    res.end(PNG)
    return
  }
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

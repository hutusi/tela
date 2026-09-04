/**
 * Serves captured feeds and a page that declares one, for e2e runs.
 *   bun run e2e/fixture-server.ts [port]
 */
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

const routes: Record<string, () => { body: Buffer | string; type: string }> = {
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
  '/blog': () => ({
    body: `<html><head><title>Fixture blog</title>
      <link rel="alternate" type="application/rss+xml" title="Fixture RSS" href="/jnito.xml"></head>
      <body><h1>Fixture blog</h1></body></html>`,
    type: 'text/html; charset=utf-8',
  }),
  '/pixel.png': () => ({ body: PNG, type: 'image/png' }),
}

createServer((req, res) => {
  const path = new URL(req.url ?? '/', 'http://x').pathname
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

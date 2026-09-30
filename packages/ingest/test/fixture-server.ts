import { readFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { join } from 'node:path'

export type RouteHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>

export type RecordedRequest = {
  path: string
  headers: Record<string, string | string[] | undefined>
}

export const FEED_FIXTURES = join(import.meta.dir, '..', '..', 'content', 'fixtures', 'feeds')

/** Small HTTP server for ingest tests: routes are set per test, requests are recorded. */
export class FixtureServer {
  private routes = new Map<string, RouteHandler>()
  readonly requests: RecordedRequest[] = []
  private constructor(
    private server: Server,
    readonly origin: string,
  ) {}

  static async start(): Promise<FixtureServer> {
    let instance: FixtureServer
    const server = createServer(async (req, res) => {
      const path = new URL(req.url ?? '/', 'http://x').pathname
      instance.requests.push({ path, headers: req.headers })
      const route = instance.routes.get(path)
      if (!route) {
        res.writeHead(404, { 'content-type': 'text/plain' })
        res.end('not found')
        return
      }
      await route(req, res)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : 0
    instance = new FixtureServer(server, `http://127.0.0.1:${port}`)
    return instance
  }

  url(path: string): string {
    return `${this.origin}${path}`
  }

  set(path: string, handler: RouteHandler) {
    this.routes.set(path, handler)
  }

  /** Serve a static body with optional status/headers. */
  text(
    path: string,
    body: string,
    options: { status?: number; headers?: Record<string, string> } = {},
  ) {
    this.set(path, (_req, res) => {
      res.writeHead(options.status ?? 200, {
        'content-type': 'application/xml; charset=utf-8',
        ...options.headers,
      })
      res.end(body)
    })
  }

  /** Serve a body with ETag support: matching If-None-Match yields 304. */
  cached(path: string, body: string, etag: string) {
    this.set(path, (req, res) => {
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, { etag })
        res.end()
        return
      }
      res.writeHead(200, { 'content-type': 'application/xml; charset=utf-8', etag })
      res.end(body)
    })
  }

  redirect(path: string, to: string, status = 301) {
    this.set(path, (_req, res) => {
      res.writeHead(status, { location: to })
      res.end()
    })
  }

  delay(path: string, ms: number, body = 'late') {
    this.set(path, async (_req, res) => {
      await new Promise((r) => setTimeout(r, ms))
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end(body)
    })
  }

  fixture(path: string, file: string) {
    this.text(path, readFileSync(join(FEED_FIXTURES, file), 'utf8'))
  }

  /** Forget routes and recorded requests between tests. */
  reset() {
    this.routes.clear()
    this.requests.length = 0
  }

  requestsFor(path: string): RecordedRequest[] {
    return this.requests.filter((r) => r.path === path)
  }

  async stop() {
    // Keep-alive connections from undici's pool would otherwise hold close() open.
    this.server.closeAllConnections()
    await new Promise<void>((resolve) => this.server.close(() => resolve()))
  }
}

/** Build a small RSS 2.0 document. */
export function rss(options: {
  title?: string
  link?: string
  items: Array<{
    guid?: string
    link?: string
    title: string
    description?: string
    content?: string
    date?: string
  }>
  ttl?: number
  /** The channel's declared language; `null` declares none, as many feeds do. */
  language?: string | null
}): string {
  const items = options.items
    .map(
      (i) => `<item>
      ${i.guid ? `<guid isPermaLink="false">${i.guid}</guid>` : ''}
      ${i.link ? `<link>${i.link}</link>` : ''}
      <title><![CDATA[${i.title}]]></title>
      ${i.description ? `<description><![CDATA[${i.description}]]></description>` : ''}
      ${i.content ? `<content:encoded><![CDATA[${i.content}]]></content:encoded>` : ''}
      ${i.date ? `<pubDate>${i.date}</pubDate>` : ''}
    </item>`,
    )
    .join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>${options.title ?? 'Test Blog'}</title>
    <link>${options.link ?? 'https://blog.example/'}</link>
    <description>A test blog</description>
    ${options.language === null ? '' : `<language>${options.language ?? 'en'}</language>`}
    ${options.ttl ? `<ttl>${options.ttl}</ttl>` : ''}
    ${items}
  </channel>
</rss>`
}

const LOREM =
  'On Calle de Toledo there is a bakery that has been open since 1928. Around it the city has been dug up, rerouted and renamed. The bread has not changed. '

/** Paragraphs of realistic length so content-mode detection sees a full article. */
export function longHtml(paragraphs = 5): string {
  return Array.from({ length: paragraphs }, (_, i) => `<p>${LOREM}Paragraph ${i + 1}.</p>`).join('')
}

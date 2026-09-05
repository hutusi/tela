/**
 * Serves the relay handler from `@tela/ingest` over Node's http module. The relay role runs this
 * alone on a Hong Kong or mainland box: no database, no queue, one shared secret.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createRelayHandler, type RelayHandlerOptions } from '@tela/ingest'

export type RelayServer = { port: number; stop: () => Promise<void> }

/**
 * A relay request is a URL and a handful of headers, so this is generous. It is enforced before
 * and while the body is read: the signature covers the body, so authentication cannot happen
 * first, and without a cap an unauthenticated client could fill the box's memory.
 */
export const MAX_RELAY_REQUEST_BYTES = 64 * 1024

function tooLarge(res: ServerResponse, req: IncomingMessage) {
  res.writeHead(413, { 'content-type': 'application/json', connection: 'close' })
  res.end(JSON.stringify({ error: 'request too large' }), () => req.destroy())
}

async function readBody(
  req: IncomingMessage,
  res: ServerResponse,
  maxBytes: number,
): Promise<Buffer | null> {
  const declared = Number(req.headers['content-length'] ?? 0)
  if (declared > maxBytes) {
    tooLarge(res, req)
    return null
  }
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    total += (chunk as Buffer).length
    if (total > maxBytes) {
      tooLarge(res, req)
      return null
    }
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks)
}

export async function startRelayServer(
  options: RelayHandlerOptions & { port: number; host?: string; maxRequestBytes?: number },
): Promise<RelayServer> {
  const handler = createRelayHandler(options)
  const maxRequestBytes = options.maxRequestBytes ?? MAX_RELAY_REQUEST_BYTES
  const server = createServer(async (req, res) => {
    try {
      const method = req.method ?? 'GET'
      // Only POST /fetch carries a body; nothing else is read.
      const body =
        method === 'GET' || method === 'HEAD' ? null : await readBody(req, res, maxRequestBytes)
      if (body === null && method !== 'GET' && method !== 'HEAD') return
      const headers = new Headers()
      for (const [name, value] of Object.entries(req.headers)) {
        if (typeof value === 'string') headers.set(name, value)
        else if (Array.isArray(value)) for (const v of value) headers.append(name, v)
      }
      const request = new Request(`http://relay${req.url ?? '/'}`, {
        method,
        headers,
        body: body === null || body.length === 0 ? null : body,
      })
      const response = await handler(request)
      res.writeHead(response.status, Object.fromEntries(response.headers))
      res.end(Buffer.from(await response.arrayBuffer()))
    } catch (err) {
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: `relay failure: ${String(err)}` }))
    }
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port, options.host ?? '0.0.0.0', () => resolve())
  })
  const address = server.address()
  const port = address && typeof address === 'object' ? address.port : options.port
  return {
    port,
    stop: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}

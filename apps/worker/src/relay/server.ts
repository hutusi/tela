/**
 * Serves the relay handler from `@tela/ingest` over Node's http module. The relay role runs this
 * alone on a Hong Kong or mainland box: no database, no queue, one shared secret.
 */
import { createServer } from 'node:http'
import { createRelayHandler, type RelayHandlerOptions } from '@tela/ingest'

export type RelayServer = { port: number; stop: () => Promise<void> }

export async function startRelayServer(
  options: RelayHandlerOptions & { port: number; host?: string },
): Promise<RelayServer> {
  const handler = createRelayHandler(options)
  const server = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk as Buffer)
      const body = Buffer.concat(chunks)
      const headers = new Headers()
      for (const [name, value] of Object.entries(req.headers)) {
        if (typeof value === 'string') headers.set(name, value)
        else if (Array.isArray(value)) for (const v of value) headers.append(name, v)
      }
      const method = req.method ?? 'GET'
      const request = new Request(`http://relay${req.url ?? '/'}`, {
        method,
        headers,
        body: method === 'GET' || method === 'HEAD' || body.length === 0 ? null : body,
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

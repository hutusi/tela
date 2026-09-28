/**
 * tela-web on Cloudflare: the only public Worker, at the reader's edge and unpinned. It holds no
 * D1 binding at all; everything that needs the database goes to tela-api (ADR 0020).
 */
import type { Request as CfRequest, ExecutionContext } from '@cloudflare/workers-types'
import { r2Blobs } from '@tela/platform/cloudflare'
import { createEdge } from './edge'
import type { Env } from './env'

let cached: { env: Env; edge: ReturnType<typeof createEdge> } | undefined

function edgeFor(env: Env) {
  if (cached?.env === env) return cached.edge
  const edge = createEdge({
    blobs: r2Blobs(env.BLOBS),
    api: { fetch: (request) => env.API.fetch(request as never) as unknown as Promise<Response> },
    cache: (caches as unknown as { default: Cache }).default as unknown as never,
    fetchImage: (url, init) => fetch(url, init),
    config: { authSecret: env.AUTH_SECRET, privateBeta: env.TELA_PRIVATE_BETA === '1' },
  })
  cached = { env, edge }
  return edge
}

export default {
  fetch(request: CfRequest, env: Env, ctx: ExecutionContext): Promise<Response> {
    return edgeFor(env).fetch(request as unknown as Request, ctx)
  },
}

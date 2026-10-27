/**
 * tela-gateway on Cloudflare (ADR 0065): `api.telaread.com`, unpinned, at the app's edge. Its
 * bindings are wired here and nowhere else; everything it does is `createGateway`'s, which the bun
 * suite runs with fakes.
 */
import type { Request as CfRequest, ExecutionContext } from '@cloudflare/workers-types'
import { r2Blobs } from '@tela/platform/cloudflare'
import type { Env } from './env'
import { createGateway } from './gateway'

let cached: { env: Env; gateway: ReturnType<typeof createGateway> } | undefined

function gatewayFor(env: Env) {
  if (cached?.env === env) return cached.gateway
  const gateway = createGateway({
    blobs: r2Blobs(env.BLOBS),
    api: { fetch: (request) => env.API.fetch(request as never) as unknown as Promise<Response> },
    cache: (caches as unknown as { default: Cache }).default as unknown as never,
    fetchImage: (url, init) => fetch(url, init),
  })
  cached = { env, gateway }
  return gateway
}

export default {
  fetch(request: CfRequest, env: Env, ctx: ExecutionContext): Promise<Response> {
    return gatewayFor(env).fetch(request as unknown as Request, ctx)
  },
}

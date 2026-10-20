/**
 * What breaks in a reader's browser, told to the Worker's logs (`POST /api/client-errors`): a
 * render an error boundary caught, an error or rejection the page left unhandled, a boot that
 * failed, a content security policy violation (ADR 0051). Visitors' pages report too, so it needs
 * no session and sits outside `/api/v1`. Nothing is stored: each report is one log line, the
 * Workers Logs of tela-api. A device that let go of its copy and starts over from a snapshot says
 * why too, logged apart as `client restart`, since it is a cost to look into rather than an error.
 *
 * Nothing in a report may name a person or a secret. Query strings are cut from the page's path
 * and from every address in the message and stack, so `/join?code=…` or `/login?email=…` never
 * reaches the logs, and the logs' own query strings are redacted too (`redact_query_string`).
 */
import { consumeLimit } from '@tela/data'
import { withoutQueries } from '@tela/shared'
import { getIP } from 'better-auth/api'
import { Hono } from 'hono'
import type { ApiEnv } from '../app'
import type { Auth } from '../auth'
import type { ApiDeps } from '../deps'
import { readAtMost } from '../read-at-most'

/** A report is a few lines of text; a stack is cut to `STACK_MAX` anyway. */
export const CLIENT_ERROR_MAX_BYTES = 8 * 1024
export const STACK_MAX = 4096
const MESSAGE_MAX = 1000
const PATH_MAX = 300
const BUILD_MAX = 64
/** What the app reports (`src/lib/report.ts`). */
export const CLIENT_ERROR_KINDS = [
  'boundary',
  'error',
  'rejection',
  'boot',
  'csp',
  'restart',
] as const
type Kind = (typeof CLIENT_ERROR_KINDS)[number]
/** better-auth's bucket for a request whose IP it cannot tell, which all such requests share. */
const NO_IP = 'no-trusted-ip'

const field = (value: unknown, max: number): string | null =>
  typeof value === 'string' ? withoutQueries(value).slice(0, max) : null

export function clientErrorRoutes(deps: ApiDeps, auth: Auth) {
  const routes = new Hono<ApiEnv>()

  routes.post('/', async (c) => {
    // Counted before anything is read, so a flood costs one statement a request, then nothing.
    const ip = getIP(c.req.raw, auth.options) ?? NO_IP
    // A policy violation, as the app says in a header, is counted apart: an extension that sets
    // them off on every page must not use up the room a real error needs.
    const name = c.req.header('x-tela-report') === 'csp' ? 'clientCsp' : 'clientError'
    const limited = await consumeLimit(deps.db, name, ip, deps.clock.now())
    if (!limited.allowed) return c.body(null, 429, { 'retry-after': String(limited.retryAfterSec) })
    if (Number(c.req.header('content-length') ?? '0') > CLIENT_ERROR_MAX_BYTES) {
      return c.json({ error: 'too_large' }, 413)
    }
    let bytes: Uint8Array<ArrayBuffer> | null
    try {
      bytes = await readAtMost(c.req.raw.body, CLIENT_ERROR_MAX_BYTES)
    } catch {
      return c.json({ error: 'unreadable' }, 400)
    }
    if (!bytes) return c.json({ error: 'too_large' }, 413)
    let body: Record<string, unknown>
    try {
      body = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>
    } catch {
      return c.json({ error: 'invalid' }, 400)
    }
    const kind = body?.kind
    const message = field(body?.message, MESSAGE_MAX)
    if (!CLIENT_ERROR_KINDS.includes(kind as Kind) || !message) {
      return c.json({ error: 'invalid' }, 400)
    }
    const line = {
      kind,
      message,
      stack: field(body.stack, STACK_MAX),
      path: field(body.path, PATH_MAX),
      build: field(body.build, BUILD_MAX),
    }
    if (kind === 'restart') console.warn('client restart', line)
    else console.error('client error', line)
    return c.body(null, 204)
  })

  return routes
}

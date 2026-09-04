/**
 * Fetch relay: a global worker asks a box in another region (Hong Kong, mainland China) to
 * perform one GET and return the raw response. Requests are HMAC-signed with a shared secret
 * and carry a timestamp so a captured request cannot be replayed later.
 *
 * Both halves are written against Web APIs only, so the handler can be served by Node's `http`
 * module in the worker and driven directly in tests without a socket.
 */
import { classify, HttpError, type HttpErrorKind, type Relay, readCapped } from './http'
import { isBlockedHost } from './net'

export const RELAY_SIGNATURE_HEADER = 'x-tela-signature'
export const RELAY_TIMESTAMP_HEADER = 'x-tela-timestamp'

/** Headers the global side may ask the relay to send; everything else is dropped. */
const FORWARDED_HEADERS = new Set([
  'user-agent',
  'accept',
  'accept-language',
  'if-none-match',
  'if-modified-since',
])

/** Hop-by-hop or transport headers that no longer describe the rebuilt body. */
const STRIPPED_HEADERS = new Set([
  'content-encoding',
  'content-length',
  'transfer-encoding',
  'connection',
  'keep-alive',
])

const NULL_BODY_STATUSES = new Set([101, 204, 205, 304])

/** Body of `POST /fetch`. */
export type RelayRequest = { url: string; headers: Record<string, string> }

/** Reply envelope. Fetch failures are `ok: false` so the caller can keep its error taxonomy. */
export type RelayReply =
  | { ok: true; status: number; headers: [string, string][]; bodyB64: string }
  | { ok: false; kind: HttpErrorKind; message: string }

async function hmacHex(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message))
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** Signature over the timestamp and the exact request body. */
export function signRelayRequest(secret: string, ts: string, body: string): Promise<string> {
  return hmacHex(secret, `${ts}\n${body}`)
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

function toBase64(bytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(bin)
}

function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  const bin = atob(text)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

export type RelayHandlerOptions = {
  /** Accepted secrets, current first. Keep the previous one here while rotating. */
  secrets: string[]
  fetch?: typeof fetch
  timeoutMs?: number
  maxBytes?: number
  /** Reject requests whose timestamp is further than this from the relay's clock. */
  maxSkewMs?: number
  /** Tests only: permit localhost and private ranges. */
  allowPrivateHosts?: boolean
  now?: () => number
}

/**
 * Relay server logic: `GET /healthz`, `POST /fetch`. Performs exactly one GET without following
 * redirects; the global side follows them, so every hop is checked against the private-network
 * rules on both ends.
 */
export function createRelayHandler(
  options: RelayHandlerOptions,
): (request: Request) => Promise<Response> {
  const secrets = options.secrets.filter(Boolean)
  if (secrets.length === 0) throw new Error('relay needs at least one secret')
  const doFetch = options.fetch ?? fetch
  const timeoutMs = options.timeoutMs ?? 20_000
  const maxBytes = options.maxBytes ?? 5 * 1024 * 1024
  const maxSkewMs = options.maxSkewMs ?? 5 * 60_000
  const now = options.now ?? (() => Date.now())

  return async (request) => {
    const path = new URL(request.url).pathname
    if (path === '/healthz' && request.method === 'GET') return json({ ok: true })
    if (path !== '/fetch') return json({ error: 'not found' }, 404)
    if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405)

    const ts = request.headers.get(RELAY_TIMESTAMP_HEADER) ?? ''
    const signature = request.headers.get(RELAY_SIGNATURE_HEADER) ?? ''
    const body = await request.text()
    const skew = Math.abs(now() - Number(ts))
    if (!ts || !Number.isFinite(skew) || skew > maxSkewMs) {
      return json({ error: 'stale or missing timestamp' }, 401)
    }
    let authentic = false
    for (const secret of secrets) {
      if (timingSafeEqual(await signRelayRequest(secret, ts, body), signature)) authentic = true
    }
    if (!authentic) return json({ error: 'bad signature' }, 401)

    let parsed: Partial<RelayRequest>
    try {
      parsed = JSON.parse(body) as Partial<RelayRequest>
    } catch {
      return json({ error: 'malformed body' }, 400)
    }
    let target: URL
    try {
      target = new URL(String(parsed.url))
    } catch {
      return json({ error: 'malformed url' }, 400)
    }
    const reply = (r: RelayReply) => json(r)
    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
      return reply({ ok: false, kind: 'blocked', message: `unsupported scheme ${target.protocol}` })
    }
    if (!options.allowPrivateHosts && isBlockedHost(target.hostname)) {
      return reply({
        ok: false,
        kind: 'blocked',
        message: `host ${target.hostname} is not allowed`,
      })
    }

    const headers: Record<string, string> = {}
    for (const [k, v] of Object.entries(parsed.headers ?? {})) {
      const name = k.toLowerCase()
      if (FORWARDED_HEADERS.has(name) && typeof v === 'string') headers[name] = v
    }

    let response: Response
    try {
      response = await doFetch(target.toString(), {
        method: 'GET',
        headers,
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (err) {
      const e = classify(err)
      return reply({ ok: false, kind: e.kind, message: e.message })
    }
    let bytes: Uint8Array = new Uint8Array()
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel().catch(() => {})
    } else {
      try {
        bytes = await readCapped(response, maxBytes)
      } catch (err) {
        const e = err instanceof HttpError ? err : classify(err)
        return reply({ ok: false, kind: e.kind, message: e.message })
      }
    }
    return reply({
      ok: true,
      status: response.status,
      headers: [...response.headers.entries()],
      bodyB64: toBase64(bytes),
    })
  }
}

/** A `fetch` that drives a relay handler in-process: tests, or a worker that is its own relay. */
export function fetchViaHandler(handler: (request: Request) => Promise<Response>): typeof fetch {
  return ((input: Parameters<typeof fetch>[0], init?: RequestInit) =>
    handler(
      input instanceof Request ? new Request(input, init) : new Request(String(input), init),
    )) as typeof fetch
}

export type RelayClientOptions = {
  /** Origin of the relay, e.g. https://relay-hk.example.com:8787. */
  relayUrl: string
  secret: string
  fetch?: typeof fetch
  timeoutMs?: number
  now?: () => number
}

/** The `relay` hook for createHttpClient: one signed POST per hop, rebuilt as a Response. */
export function createRelayClient(options: RelayClientOptions): Relay {
  const endpoint = new URL('/fetch', options.relayUrl).toString()
  const doFetch = options.fetch ?? fetch
  const now = options.now ?? (() => Date.now())
  const timeoutMs = options.timeoutMs ?? 30_000

  return async (url, init) => {
    const headers: Record<string, string> = {}
    for (const [k, v] of new Headers(init.headers ?? {})) {
      if (FORWARDED_HEADERS.has(k)) headers[k] = v
    }
    const body = JSON.stringify({ url, headers } satisfies RelayRequest)
    const ts = String(now())
    const signature = await signRelayRequest(options.secret, ts, body)

    let res: Response
    try {
      res = await doFetch(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [RELAY_TIMESTAMP_HEADER]: ts,
          [RELAY_SIGNATURE_HEADER]: signature,
        },
        body,
        signal: init.signal ?? AbortSignal.timeout(timeoutMs),
      })
    } catch (err) {
      const e = classify(err)
      throw new HttpError(e.kind, `relay: ${e.message}`)
    }
    if (res.status !== 200) {
      await res.body?.cancel().catch(() => {})
      throw new HttpError('network', `relay responded ${res.status}`)
    }
    const reply = (await res.json()) as RelayReply
    if (!reply.ok) throw new HttpError(reply.kind, `relay: ${reply.message}`)

    const out = new Headers()
    for (const [k, v] of reply.headers) {
      if (!STRIPPED_HEADERS.has(k.toLowerCase())) out.append(k, v)
    }
    const bytes = fromBase64(reply.bodyB64)
    const nullBody = bytes.length === 0 || NULL_BODY_STATUSES.has(reply.status)
    return new Response(nullBody ? null : bytes, { status: reply.status, headers: out })
  }
}

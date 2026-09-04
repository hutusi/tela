import type { FetchRegion } from '@tela/shared'
import { isBlockedHost } from './net'

export type HttpErrorKind = 'timeout' | 'network' | 'too_large' | 'redirect_loop' | 'blocked'

export class HttpError extends Error {
  override name = 'HttpError'
  constructor(
    public kind: HttpErrorKind,
    message: string,
  ) {
    super(message)
  }
}

export type HttpResponse = {
  status: number
  headers: Headers
  body: string
  /** Undecoded response body, for images and other binary payloads. */
  raw: Uint8Array
  bytes: number
  finalUrl: string
  /** Set when every redirect hop was permanent (301/308): the caller may adopt it. */
  permanentRedirectTo: string | null
  elapsedMs: number
}

export type HttpGetOptions = {
  etag?: string | null
  lastModified?: string | null
  region?: FetchRegion
  accept?: string
}

export type HttpClient = {
  get(url: string, options?: HttpGetOptions): Promise<HttpResponse>
}

/** A relay performs the request elsewhere (a HK/CN box) and returns a Response. */
export type Relay = (url: string, init: RequestInit) => Promise<Response>

export type HttpClientOptions = {
  userAgent: string
  timeoutMs?: number
  maxBytes?: number
  /** Minimum spacing between requests to the same host. */
  politenessMs?: number
  maxRedirects?: number
  fetch?: typeof fetch
  relay?: Relay
  /** Test hook: replaces the wall clock used for politeness. */
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  /** Tests only: permit localhost and private ranges. */
  allowPrivateHosts?: boolean
}

const RELAY_HEADROOM_MS = 10_000

const DEFAULT_ACCEPT =
  'application/rss+xml, application/atom+xml, application/feed+json, application/xml;q=0.9, text/xml;q=0.9, text/html;q=0.8, */*;q=0.5'

function charsetOf(contentType: string | null, body: Uint8Array): string {
  const fromHeader = contentType?.match(/charset=["']?([\w-]+)/i)?.[1]
  if (fromHeader) return fromHeader.toLowerCase()
  const head = new TextDecoder('latin1' as 'utf-8').decode(body.subarray(0, 1024))
  const fromXml = head.match(/^<\?xml[^>]*encoding=["']([\w-]+)["']/i)?.[1]
  if (fromXml) return fromXml.toLowerCase()
  const fromMeta = head.match(/<meta[^>]+charset=["']?([\w-]+)/i)?.[1]
  return fromMeta?.toLowerCase() ?? 'utf-8'
}

function decodeBody(bytes: Uint8Array, contentType: string | null): string {
  const charset = charsetOf(contentType, bytes)
  try {
    return new TextDecoder(charset as 'utf-8').decode(bytes)
  } catch {
    return new TextDecoder('utf-8').decode(bytes)
  }
}

export function classify(err: unknown): HttpError {
  const e = err as {
    name?: string
    code?: string
    cause?: { code?: string; name?: string; message?: string }
    message?: string
  }
  const code = e.cause?.code ?? e.code ?? ''
  const name = e.name ?? e.cause?.name ?? ''
  // The worker's DNS-pinned fetch refuses names that resolve to private addresses.
  if (code === 'EBLOCKED') {
    return new HttpError('blocked', e.cause?.message ?? e.message ?? 'address not allowed')
  }
  if (
    name === 'TimeoutError' ||
    name === 'AbortError' ||
    /TIMEOUT|ECONNRESET|EPIPE|ECONNABORTED/i.test(code)
  ) {
    return new HttpError('timeout', `request timed out (${code || name})`)
  }
  return new HttpError('network', `request failed (${code || name || e.message || 'unknown'})`)
}

/**
 * Pass bytes through until `maxBytes`, then fail the stream with a `too_large` HttpError and
 * cancel the upstream body. Counts what actually arrives, so a missing or dishonest
 * Content-Length changes nothing; usable for proxying as well as for buffering.
 */
export function cappedStream(
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
): ReadableStream<Uint8Array> {
  let total = 0
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        total += chunk.byteLength
        if (total > maxBytes) {
          controller.error(new HttpError('too_large', `response exceeds ${maxBytes} bytes`))
          return
        }
        controller.enqueue(chunk)
      },
    }),
  )
}

/** Buffer a body through `cappedStream`. Accepts a Request as well as a Response. */
export async function readCapped(
  message: { body: ReadableStream<Uint8Array> | null },
  maxBytes: number,
): Promise<Uint8Array> {
  if (!message.body) return new Uint8Array()
  const reader = cappedStream(message.body, maxBytes).getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    chunks.push(value)
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.byteLength
  }
  return out
}

/**
 * Polite HTTP GET for feeds and pages: conditional headers, manual redirects with
 * permanent-redirect detection, byte cap, charset-aware decoding, per-host spacing,
 * private-network blocking, and an optional relay for the cn region.
 */
export function createHttpClient(options: HttpClientOptions): HttpClient {
  const timeoutMs = options.timeoutMs ?? 20_000
  const maxBytes = options.maxBytes ?? 5 * 1024 * 1024
  const politenessMs = options.politenessMs ?? 2_000
  const maxRedirects = options.maxRedirects ?? 5
  const doFetch = options.fetch ?? fetch
  const now = options.now ?? (() => Date.now())
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)))
  const lastRequestAt = new Map<string, number>()

  async function politeWait(host: string) {
    const last = lastRequestAt.get(host)
    if (last !== undefined) {
      const wait = last + politenessMs - now()
      if (wait > 0) await sleep(wait)
    }
    lastRequestAt.set(host, now())
  }

  return {
    async get(url, opts = {}) {
      const started = now()
      const headers: Record<string, string> = {
        'user-agent': options.userAgent,
        accept: opts.accept ?? DEFAULT_ACCEPT,
        'accept-language': '*',
      }
      if (opts.etag) headers['if-none-match'] = opts.etag
      if (opts.lastModified) headers['if-modified-since'] = opts.lastModified

      let current = url
      let allPermanent = true
      let hops = 0
      for (;;) {
        const parsed = new URL(current)
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          throw new HttpError('blocked', `unsupported scheme ${parsed.protocol}`)
        }
        if (!options.allowPrivateHosts && isBlockedHost(parsed.hostname)) {
          throw new HttpError('blocked', `host ${parsed.hostname} is not allowed`)
        }
        await politeWait(parsed.host)

        const relay = opts.region === 'cn' ? options.relay : undefined
        const init: RequestInit = {
          method: 'GET',
          headers,
          redirect: 'manual',
          // The relay applies the same timeout upstream; give its round trip some headroom.
          signal: AbortSignal.timeout(relay ? timeoutMs + RELAY_HEADROOM_MS : timeoutMs),
        }
        let response: Response
        try {
          response = relay ? await relay(current, init) : await doFetch(current, init)
        } catch (err) {
          // The relay client already speaks our error taxonomy; only raw fetch errors need mapping.
          throw err instanceof HttpError ? err : classify(err)
        }

        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = response.headers.get('location')
          await response.body?.cancel().catch(() => {})
          if (!location)
            return {
              status: response.status,
              headers: response.headers,
              body: '',
              raw: new Uint8Array(),
              bytes: 0,
              finalUrl: current,
              permanentRedirectTo: null,
              elapsedMs: now() - started,
            }
          hops += 1
          if (hops > maxRedirects)
            throw new HttpError('redirect_loop', `more than ${maxRedirects} redirects`)
          if (response.status !== 301 && response.status !== 308) allPermanent = false
          current = new URL(location, current).toString()
          continue
        }

        let bytes: Uint8Array
        try {
          bytes = await readCapped(response, maxBytes)
        } catch (err) {
          if (err instanceof HttpError) throw err
          throw classify(err)
        }
        const body =
          bytes.byteLength === 0 ? '' : decodeBody(bytes, response.headers.get('content-type'))
        return {
          status: response.status,
          headers: response.headers,
          body,
          raw: bytes,
          bytes: bytes.byteLength,
          finalUrl: current,
          permanentRedirectTo: hops > 0 && allPermanent && current !== url ? current : null,
          elapsedMs: now() - started,
        }
      }
    },
  }
}

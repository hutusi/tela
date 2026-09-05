/**
 * WebSub (PubSubHubbub) subscriber side. The worker asks a feed's hub to push notifications to
 * the web app's callback; the hub verifies the request with a GET and later POSTs signed pings.
 * Web APIs only, so the signature check runs on Cloudflare too.
 */
import { classify } from './http'
import { isBlockedHost } from './net'

export const WEBSUB_LEASE_SECONDS = 10 * 24 * 3600

const ALGORITHMS = {
  sha1: 'SHA-1',
  sha256: 'SHA-256',
  sha384: 'SHA-384',
  sha512: 'SHA-512',
} as const
export type HubSignatureAlgorithm = keyof typeof ALGORITHMS

/** 32 random bytes as hex; well under the spec's 200-byte cap on hub.secret. */
export function newWebsubSecret(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export async function hubSignature(
  secret: string,
  body: Uint8Array,
  algorithm: HubSignatureAlgorithm = 'sha256',
): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: ALGORITHMS[algorithm] },
    false,
    ['sign'],
  )
  const data = body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer
  const sig = await crypto.subtle.sign('HMAC', key, data)
  const hex = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('')
  return `${algorithm}=${hex}`
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/** Validate an `X-Hub-Signature` header (`<algo>=<hex>`) against the body. */
export async function verifyHubSignature(
  secret: string,
  body: Uint8Array,
  header: string | null | undefined,
): Promise<boolean> {
  const match = /^\s*(sha1|sha256|sha384|sha512)=([0-9a-f]+)\s*$/i.exec(header ?? '')
  if (!match) return false
  const algorithm = match[1]?.toLowerCase() as HubSignatureAlgorithm
  const expected = await hubSignature(secret, body, algorithm)
  return timingSafeEqual(expected, `${algorithm}=${match[2]?.toLowerCase()}`)
}

export type HubSubscribeOptions = {
  hubUrl: string
  topicUrl: string
  callbackUrl: string
  secret: string
  mode?: 'subscribe' | 'unsubscribe'
  leaseSeconds?: number
  fetch?: typeof fetch
  timeoutMs?: number
  /** Tests only: permit localhost hubs. */
  allowPrivateHosts?: boolean
}

export type HubSubscribeResult = { ok: true; status: number } | { ok: false; error: string }

/** POST the subscription request; hubs answer 202 and verify the callback out of band. */
export async function requestHubSubscription(
  options: HubSubscribeOptions,
): Promise<HubSubscribeResult> {
  let hub: URL
  try {
    hub = new URL(options.hubUrl)
  } catch {
    return { ok: false, error: 'hub url is not valid' }
  }
  if (hub.protocol !== 'http:' && hub.protocol !== 'https:') {
    return { ok: false, error: `unsupported hub scheme ${hub.protocol}` }
  }
  if (!options.allowPrivateHosts && isBlockedHost(hub.hostname)) {
    return { ok: false, error: `hub host ${hub.hostname} is not allowed` }
  }
  const form = new URLSearchParams({
    'hub.mode': options.mode ?? 'subscribe',
    'hub.topic': options.topicUrl,
    'hub.callback': options.callbackUrl,
    'hub.secret': options.secret,
    'hub.lease_seconds': String(options.leaseSeconds ?? WEBSUB_LEASE_SECONDS),
  })
  const doFetch = options.fetch ?? fetch
  try {
    const res = await doFetch(hub.toString(), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: '*/*' },
      body: form.toString(),
      redirect: 'manual',
      signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
    })
    await res.body?.cancel().catch(() => {})
    if (res.status >= 200 && res.status < 300) return { ok: true, status: res.status }
    return { ok: false, error: `hub responded ${res.status}` }
  } catch (err) {
    return { ok: false, error: classify(err).message }
  }
}

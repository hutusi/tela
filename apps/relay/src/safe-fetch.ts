import { lookup as dnsLookup } from 'node:dns/promises'
import type { LookupFunction } from 'node:net'
import { isBlockedHost, isPrivateAddress } from '@tela/ingest/net'
import { Agent, fetch as undiciFetch } from 'undici'

export type ResolvedAddress = { address: string; family: number }
export type Resolver = (hostname: string) => Promise<ResolvedAddress[]>

export type SafeFetchOptions = {
  /** Test hook: replaces DNS. */
  resolve?: Resolver
  /** Tests only: permit localhost and private ranges (the fixture server). */
  allowPrivateHosts?: boolean
  connectTimeoutMs?: number
}

/** Raised from the socket's lookup; `classify` in @tela/ingest maps its code to `blocked`. */
export class BlockedAddressError extends Error {
  override name = 'BlockedAddressError'
  readonly code = 'EBLOCKED'
  constructor(hostname: string, address: string) {
    super(
      hostname === address
        ? `host ${hostname} is not allowed`
        : `host ${hostname} resolves to ${address}, which is not allowed`,
    )
  }
}

/**
 * A `net.connect` lookup that resolves every address for a name and refuses the connection if
 * any of them is private. Because the socket then connects to exactly the address this
 * returned, there is no resolve-then-connect gap for DNS rebinding to slip through, and TLS
 * still validates the certificate against the host name.
 */
export function createVettedLookup(options: SafeFetchOptions = {}): LookupFunction {
  const resolve = options.resolve ?? ((hostname: string) => dnsLookup(hostname, { all: true }))
  return (hostname, lookupOptions, callback) => {
    resolve(hostname).then(
      (addresses) => {
        if (addresses.length === 0) {
          const err = Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), {
            code: 'ENOTFOUND',
          })
          return callback(err, '', 4)
        }
        if (!options.allowPrivateHosts) {
          const bad = addresses.find((a) => isPrivateAddress(a.address))
          if (bad) return callback(new BlockedAddressError(hostname, bad.address), '', 4)
        }
        const first = addresses[0] as ResolvedAddress
        if (lookupOptions.all) return callback(null, addresses)
        return callback(null, first.address, first.family)
      },
      (err: NodeJS.ErrnoException) => callback(err, '', 4),
    )
  }
}

/**
 * A fetch whose sockets only ever connect to addresses the vetted lookup returned. Node only:
 * under Bun the `undici` import is Bun's built-in shim, whose Agent is inert, so `bun run
 * dev:worker` keeps the name and literal-address checks but not the pinning.
 */
export function createSafeFetch(options: SafeFetchOptions = {}): typeof fetch {
  const agent = new Agent({
    connect: { lookup: createVettedLookup(options), timeout: options.connectTimeoutMs ?? 10_000 },
  })
  const safeFetch = async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    // Literal addresses never reach the lookup, so they are checked here; the error takes the
    // shape undici gives connection failures, which `classify` already understands.
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const host = new URL(href).hostname
    if (!options.allowPrivateHosts && isBlockedHost(host)) {
      throw new TypeError('fetch failed', { cause: new BlockedAddressError(host, host) })
    }
    return undiciFetch(input as never, { ...(init as object), dispatcher: agent } as never)
  }
  return safeFetch as unknown as typeof fetch
}

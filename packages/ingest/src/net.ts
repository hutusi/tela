/**
 * Textual IP parsing and the private-address rules for outbound fetches. Pure and
 * runtime-agnostic: the web app's image proxy and the worker's DNS-pinned fetch both use it.
 */

export type ParsedIp = { family: 4 | 6; bytes: Uint8Array }

const V4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/

function parseV4(text: string): Uint8Array | null {
  const m = V4.exec(text)
  if (!m) return null
  const out = new Uint8Array(4)
  for (let i = 0; i < 4; i++) {
    const n = Number(m[i + 1])
    if (n > 255) return null
    out[i] = n
  }
  return out
}

function parseV6(text: string): Uint8Array | null {
  if (!text.includes(':') || !/^[0-9a-f:.]+$/.test(text)) return null
  let head = text
  // An embedded IPv4 tail (::ffff:10.0.0.1) becomes its two hex groups.
  if (text.includes('.')) {
    const cut = text.lastIndexOf(':')
    const tail = parseV4(text.slice(cut + 1))
    if (!tail) return null
    const hi = ((tail[0] as number) << 8) | (tail[1] as number)
    const lo = ((tail[2] as number) << 8) | (tail[3] as number)
    head = `${text.slice(0, cut + 1)}${hi.toString(16)}:${lo.toString(16)}`
  }
  const halves = head.split('::')
  if (halves.length > 2) return null
  const left = halves[0] ? halves[0].split(':') : []
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  const missing = halves.length === 2 ? 8 - left.length - right.length : 0
  if (missing < 0) return null
  const groups = [...left, ...Array.from({ length: missing }, () => '0'), ...right]
  if (groups.length !== 8) return null
  const out = new Uint8Array(16)
  for (let i = 0; i < 8; i++) {
    const g = groups[i] as string
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null
    const n = Number.parseInt(g, 16)
    out[i * 2] = n >> 8
    out[i * 2 + 1] = n & 0xff
  }
  return out
}

/** Strict textual IPv4/IPv6 parser (brackets and zone ids stripped); null for anything else. */
export function parseIp(text: string): ParsedIp | null {
  let s = text.trim().toLowerCase()
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1)
  const zone = s.indexOf('%')
  if (zone !== -1) s = s.slice(0, zone)
  const v4 = parseV4(s)
  if (v4) return { family: 4, bytes: v4 }
  const v6 = parseV6(s)
  if (v6) return { family: 6, bytes: v6 }
  return null
}

function hasPrefix(bytes: Uint8Array, prefix: number[], bits: number): boolean {
  for (let i = 0; i < bits; i++) {
    const mask = 0x80 >> (i & 7)
    if (((bytes[i >> 3] as number) & mask) !== ((prefix[i >> 3] as number) & mask)) return false
  }
  return true
}

/** IPv4 ranges that are never a public origin: RFC 1918, loopback, link-local, CGNAT, and the rest of RFC 6890. */
const V4_BLOCKED: Array<[number[], number]> = [
  [[0, 0, 0, 0], 8],
  [[10, 0, 0, 0], 8],
  [[100, 64, 0, 0], 10],
  [[127, 0, 0, 0], 8],
  [[169, 254, 0, 0], 16],
  [[172, 16, 0, 0], 12],
  [[192, 0, 0, 0], 24],
  [[192, 0, 2, 0], 24],
  [[192, 168, 0, 0], 16],
  [[198, 18, 0, 0], 15],
  [[198, 51, 100, 0], 24],
  [[203, 0, 113, 0], 24],
  [[224, 0, 0, 0], 4],
  [[240, 0, 0, 0], 4],
]

function isPrivate(ip: ParsedIp): boolean {
  const b = ip.bytes
  if (ip.family === 4) return V4_BLOCKED.some(([prefix, bits]) => hasPrefix(b, prefix, bits))
  const zero = (from: number, to: number) => b.subarray(from, to + 1).every((x) => x === 0)
  const tail = () => isPrivate({ family: 4, bytes: b.subarray(12) })
  // ::/96 (IPv4-compatible, including :: and ::1) and ::ffff:0:0/96 (IPv4-mapped) embed a v4.
  if (zero(0, 11)) return true
  if (zero(0, 9) && b[10] === 0xff && b[11] === 0xff) return tail()
  // 64:ff9b::/96 (NAT64) embeds a v4; 64:ff9b:1::/48 is local-use NAT64.
  if (b[0] === 0 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b) {
    if (zero(4, 11)) return tail()
    if (b[4] === 0 && b[5] === 1) return true
  }
  // 2002::/16 (6to4) embeds a v4 in bytes 2..5.
  if (b[0] === 0x20 && b[1] === 0x02) return isPrivate({ family: 4, bytes: b.subarray(2, 6) })
  // 2001::/32 (Teredo, client address obfuscated) and 2001:db8::/32 (documentation).
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0 && b[3] === 0) return true
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return true
  // Everything outside global unicast 2000::/3 is link-local, unique-local (fc00::/7, which
  // includes Fly's fdaa::/16), multicast, or reserved.
  return ((b[0] as number) & 0xe0) !== 0x20
}

/** True for any address that is not a public origin. Unparseable input counts as private. */
export function isPrivateAddress(address: string): boolean {
  const parsed = parseIp(address)
  return parsed === null ? true : isPrivate(parsed)
}

/**
 * Host names and literal addresses that outbound fetches must never reach: private and
 * reserved addresses, and names that only resolve inside a machine or a LAN. Callers pass
 * `URL.hostname`, which the WHATWG parser has already canonicalised (`127.1`, `0x7f000001`,
 * and bracketed IPv6 all arrive in normal form).
 */
export function isBlockedHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '')
  if (host.startsWith('[') || host.includes(':') || /^\d+(\.\d+){3}$/.test(host)) {
    return isPrivateAddress(host)
  }
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host.endsWith('.home.arpa')
  )
}

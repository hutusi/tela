import { NORM_VERSION } from '@tela/shared'

const encoder = new TextEncoder()

/** SHA-256 hex via Web Crypto, so it runs on Node, Bun, and Cloudflare Workers alike. */
export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(input))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** NFC, trimmed, whitespace collapsed: the form that is hashed. */
export function normalizeForHash(text: string): string {
  return text.normalize('NFC').replace(/\s+/g, ' ').trim()
}

/** Full content hash of a block's tagged text, bound to NORM_VERSION. */
export async function blockHash(taggedText: string): Promise<string> {
  return sha256Hex(`${normalizeForHash(taggedText)} v${NORM_VERSION}`)
}

/** Short id used in data-tb attributes; duplicates get a -2, -3 suffix elsewhere. */
export function shortId(hash: string): string {
  return hash.slice(0, 10)
}

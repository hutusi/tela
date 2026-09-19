/**
 * Signed image proxy URLs. Stored article HTML keeps original image URLs; at render
 * time they are rewritten to /img?u=<base64url>&s=<hmac>. The proxy verifies the
 * signature before fetching, so it cannot be used as an open proxy.
 */
import render from 'dom-serializer'
import { type Element, isTag, type ParentNode } from 'domhandler'
import { findAll } from 'domutils'
import { parseDocument } from 'htmlparser2'

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const keys = new Map<string, Promise<CryptoKey>>()

function hmacKey(secret: string): Promise<CryptoKey> {
  let key = keys.get(secret)
  if (!key) {
    key = crypto.subtle.importKey(
      'raw',
      encoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    )
    keys.set(secret, key)
  }
  return key
}

export function toBase64Url(text: string): string {
  const bytes = encoder.encode(text)
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function fromBase64Url(value: string): string | null {
  try {
    const padded = value
      .replace(/-/g, '+')
      .replace(/_/g, '/')
      .padEnd(Math.ceil(value.length / 4) * 4, '=')
    const binary = atob(padded)
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0))
    return decoder.decode(bytes)
  } catch {
    return null
  }
}

async function signature(secret: string, encodedUrl: string): Promise<string> {
  const key = await hmacKey(secret)
  const mac = await crypto.subtle.sign('HMAC', key, encoder.encode(encodedUrl))
  return [...new Uint8Array(mac)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 32)
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/** Build a proxy URL for an original image URL. */
export async function signImageUrl(url: string, secret: string, prefix = '/img'): Promise<string> {
  const u = toBase64Url(url)
  const s = await signature(secret, u)
  return `${prefix}?u=${u}&s=${s}`
}

/** Verify proxy parameters; returns the original http(s) URL or null. */
export async function verifyImageParams(
  u: string,
  s: string,
  secret: string,
): Promise<string | null> {
  if (!u || !s) return null
  const expected = await signature(secret, u)
  if (!timingSafeEqual(expected, s)) return null
  const url = fromBase64Url(u)
  if (!url) return null
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    return parsed.toString()
  } catch {
    return null
  }
}

/**
 * Rewrite every <img src> in an already-parsed tree through `sign`, in place.
 *
 * Separate from `rewriteImages` so a caller that parses for its own reasons pays for one parse
 * rather than two: `renderArticleBlocks` splits and signs in the same pass.
 */
export async function rewriteImagesIn(
  doc: ParentNode,
  sign: (url: string) => Promise<string>,
): Promise<void> {
  const images = findAll((el): el is Element => isTag(el) && el.name === 'img', doc.children)
  await Promise.all(
    images.map(async (img) => {
      const src = img.attribs.src
      if (!src || !/^https?:\/\//i.test(src)) return
      img.attribs['data-origin'] = new URL(src).hostname
      img.attribs.src = await sign(src)
    }),
  )
}

/** Rewrite every <img src> in article HTML through `sign`. */
export async function rewriteImages(
  html: string,
  sign: (url: string) => Promise<string>,
): Promise<string> {
  const doc = parseDocument(html)
  await rewriteImagesIn(doc, sign)
  return render(doc, { encodeEntities: 'utf8' })
}

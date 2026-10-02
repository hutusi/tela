/**
 * What a picture is, read from its own first bytes (ADR 0033): the type and the size a browser
 * will decode it to, never what an upload declared. Headers only: no pixel is decoded, so a file
 * that claims a huge canvas is refused before anything is drawn. PNG, JPEG and WebP; anything
 * else, SVG above all, is not a picture here.
 */

export type PictureType = 'image/png' | 'image/jpeg' | 'image/webp'
export type PictureInfo = { type: PictureType; width: number; height: number }

const ascii = (bytes: Uint8Array, at: number, text: string) =>
  [...text].every((c, i) => bytes[at + i] === c.charCodeAt(0))
const u16be = (b: Uint8Array, at: number) => ((b[at] ?? 0) << 8) | (b[at + 1] ?? 0)
const u32be = (b: Uint8Array, at: number) => u16be(b, at) * 65536 + u16be(b, at + 2)
const u16le = (b: Uint8Array, at: number) => (b[at] ?? 0) | ((b[at + 1] ?? 0) << 8)
const u24le = (b: Uint8Array, at: number) => u16le(b, at) | ((b[at + 2] ?? 0) << 16)

function png(b: Uint8Array): PictureInfo | null {
  // The signature, then IHDR first, always: its width and height lead it.
  if (b.length < 24 || !ascii(b, 1, 'PNG') || b[0] !== 0x89 || !ascii(b, 12, 'IHDR')) return null
  return { type: 'image/png', width: u32be(b, 16), height: u32be(b, 20) }
}

/** The start-of-frame markers that carry a JPEG's size; DHT, JPG and DAC are not among them. */
const SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf])

function jpeg(b: Uint8Array): PictureInfo | null {
  if (b[0] !== 0xff || b[1] !== 0xd8) return null
  let at = 2
  while (at + 3 < b.length) {
    if (b[at] !== 0xff) return null
    const marker = b[at + 1] ?? 0
    // Fill bytes, and markers that stand alone, carry no length.
    if (marker === 0xff) {
      at += 1
      continue
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      at += 2
      continue
    }
    // The image data begins: no frame header came first.
    if (marker === 0xda || marker === 0xd9) return null
    if (SOF.has(marker)) {
      if (at + 9 > b.length) return null
      return { type: 'image/jpeg', width: u16be(b, at + 7), height: u16be(b, at + 5) }
    }
    const length = u16be(b, at + 2)
    if (length < 2) return null
    at += 2 + length
  }
  return null
}

function webp(b: Uint8Array): PictureInfo | null {
  if (b.length < 21 || !ascii(b, 0, 'RIFF') || !ascii(b, 8, 'WEBP')) return null
  // Lossy: a key frame's start code, then 14-bit sizes.
  if (ascii(b, 12, 'VP8 ')) {
    if (b.length < 30 || b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null
    return { type: 'image/webp', width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff }
  }
  // Lossless: a signature byte, then two 14-bit sizes less one, packed.
  if (ascii(b, 12, 'VP8L')) {
    if (b.length < 25 || b[20] !== 0x2f) return null
    const bits = (b[21] ?? 0) | ((b[22] ?? 0) << 8) | ((b[23] ?? 0) << 16) | ((b[24] ?? 0) << 24)
    return { type: 'image/webp', width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 }
  }
  // Extended: the canvas, as 24-bit sizes less one.
  if (ascii(b, 12, 'VP8X')) {
    if (b.length < 30) return null
    return { type: 'image/webp', width: u24le(b, 24) + 1, height: u24le(b, 27) + 1 }
  }
  return null
}

/** The picture `bytes` are, or null when they are not a PNG, JPEG or WebP this can read. */
export function pictureInfo(bytes: Uint8Array): PictureInfo | null {
  const info = png(bytes) ?? jpeg(bytes) ?? webp(bytes)
  return info && info.width > 0 && info.height > 0 ? info : null
}

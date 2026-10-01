import { describe, expect, test } from 'bun:test'
import { pictureInfo } from './picture'

const bytes = (...parts: (number[] | string)[]) =>
  new Uint8Array(
    parts.flatMap((p) => (typeof p === 'string' ? [...p].map((c) => c.charCodeAt(0)) : p)),
  )
const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]
const le16 = (n: number) => [n & 255, (n >>> 8) & 255]
const le24 = (n: number) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255]

const png = (w: number, h: number) =>
  bytes(
    [0x89],
    'PNG',
    [0x0d, 0x0a, 0x1a, 0x0a],
    be32(13),
    'IHDR',
    be32(w),
    be32(h),
    [8, 6, 0, 0, 0],
  )

/** SOI, an APP0 segment to step over, then a baseline frame header. */
const jpeg = (w: number, h: number, sof = 0xc0) =>
  bytes(
    [0xff, 0xd8],
    [0xff, 0xe0, 0x00, 0x10],
    'JFIF',
    [0, 1, 1, 0, 0, 1, 0, 1, 0, 0],
    [0xff, sof, 0x00, 0x11, 0x08],
    [(h >> 8) & 255, h & 255, (w >> 8) & 255, w & 255],
    [3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1],
  )

const riff = (chunk: string, body: number[]) =>
  bytes('RIFF', [0, 0, 0, 0], 'WEBP', chunk, [body.length, 0, 0, 0], body)

describe('pictureInfo', () => {
  test('reads a PNG from its IHDR', () => {
    expect(pictureInfo(png(256, 256))).toEqual({ type: 'image/png', width: 256, height: 256 })
  })

  test('reads a JPEG from its frame header, stepping over the segments before it', () => {
    expect(pictureInfo(jpeg(300, 200))).toEqual({ type: 'image/jpeg', width: 300, height: 200 })
    expect(pictureInfo(jpeg(640, 640, 0xc2))).toMatchObject({ width: 640, height: 640 }) // progressive
  })

  test('reads all three kinds of WebP', () => {
    // Lossy: frame tag, then the start code and 14-bit sizes.
    const lossy = riff('VP8 ', [0, 0, 0, 0x9d, 0x01, 0x2a, ...le16(256), ...le16(256)])
    expect(pictureInfo(lossy)).toEqual({ type: 'image/webp', width: 256, height: 256 })
    // Lossless: 0x2f, then (width - 1) in 14 bits and (height - 1) in the next 14.
    const packed = (255 & 0x3fff) | ((127 & 0x3fff) << 14)
    const lossless = riff('VP8L', [
      0x2f,
      packed & 255,
      (packed >>> 8) & 255,
      (packed >>> 16) & 255,
      (packed >>> 24) & 255,
    ])
    expect(pictureInfo(lossless)).toEqual({ type: 'image/webp', width: 256, height: 128 })
    // Extended: flags, reserved, then the canvas less one.
    const extended = riff('VP8X', [0x10, 0, 0, 0, ...le24(511), ...le24(511)])
    expect(pictureInfo(extended)).toEqual({ type: 'image/webp', width: 512, height: 512 })
  })

  test('says nothing of what is not a PNG, JPEG or WebP', () => {
    expect(pictureInfo(bytes('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull()
    expect(pictureInfo(bytes('GIF89a', le16(10), le16(10)))).toBeNull()
    expect(pictureInfo(bytes('<html><body>hi</body></html>'))).toBeNull()
    expect(pictureInfo(new Uint8Array())).toBeNull()
  })

  test('refuses a file cut short, or one that claims no size', () => {
    expect(pictureInfo(png(256, 256).slice(0, 20))).toBeNull()
    expect(pictureInfo(jpeg(300, 200).slice(0, 24))).toBeNull()
    expect(pictureInfo(png(0, 256))).toBeNull()
    expect(pictureInfo(riff('VP8X', [0x10, 0, 0, 0, 1, 0]))).toBeNull()
    // Image data before any frame header.
    expect(pictureInfo(bytes([0xff, 0xd8, 0xff, 0xda, 0x00, 0x08]))).toBeNull()
  })
})

import { describe, expect, test } from 'bun:test'
import { blockHash, normalizeForHash, sha256Hex, shortId } from './hash'

describe('hash', () => {
  test('sha256Hex matches a known vector', async () => {
    expect(await sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
  })

  test('normalizeForHash collapses whitespace and applies NFC', () => {
    expect(normalizeForHash('  a \n\t b  ')).toBe('a b')
    // e + combining acute accent becomes the precomposed character
    expect(normalizeForHash('é')).toBe('é')
  })

  test('blockHash is stable for whitespace variants and differs for content', async () => {
    const a = await blockHash('Hello <g1>world</g1>')
    const b = await blockHash('Hello   <g1>world</g1>\n')
    const c = await blockHash('Hello <g1>there</g1>')
    expect(a).toBe(b)
    expect(a).not.toBe(c)
    expect(shortId(a)).toHaveLength(10)
  })
})

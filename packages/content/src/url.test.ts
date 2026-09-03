import { describe, expect, test } from 'bun:test'
import { absoluteUrl, displayHost, normalizeForDedup, normalizeOrigin } from './url'

describe('url', () => {
  test('absoluteUrl resolves relative links and rejects non-http', () => {
    expect(absoluteUrl('/post/1', 'https://example.com/feed')).toBe('https://example.com/post/1')
    expect(absoluteUrl('javascript:alert(1)')).toBeNull()
    expect(absoluteUrl('mailto:a@b.c')).toBeNull()
    expect(absoluteUrl('not a url')).toBeNull()
  })

  test('normalizeOrigin keeps scheme, lowercases host, drops path', () => {
    expect(normalizeOrigin('HTTP://Example.COM/blog/?x=1')).toBe('http://example.com')
    expect(normalizeOrigin('https://example.com:443/')).toBe('https://example.com')
    expect(normalizeOrigin('https://example.com:8443/')).toBe('https://example.com:8443')
  })

  test('normalizeForDedup strips tracking, sorts params, upgrades to https', () => {
    expect(normalizeForDedup('http://Example.com/a/b/?utm_source=x&b=2&a=1&fbclid=zz#frag')).toBe(
      'https://example.com/a/b?a=1&b=2',
    )
    expect(normalizeForDedup('https://example.com/')).toBe('https://example.com/')
    expect(normalizeForDedup('https://example.com/post?spm=abc')).toBe('https://example.com/post')
  })

  test('displayHost strips www', () => {
    expect(displayHost('https://www.example.com/x')).toBe('example.com')
  })
})

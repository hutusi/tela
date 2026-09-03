import { describe, expect, test } from 'bun:test'
import { dedupKey } from './dedup'

describe('dedupKey', () => {
  test('prefers guid, then normalized link, then title hash', async () => {
    expect(
      await dedupKey({ guid: ' abc ', url: 'https://x/y', title: 't', publishedAt: null }),
    ).toBe('g:abc')
    expect(
      await dedupKey({
        guid: '',
        url: 'http://X.example/p/?utm_source=a',
        title: 't',
        publishedAt: null,
      }),
    ).toBe('u:https://x.example/p')
    const date = new Date('2026-01-02T03:04:05Z')
    const a = await dedupKey({ guid: null, url: null, title: 'Same', publishedAt: date })
    const b = await dedupKey({ guid: null, url: null, title: 'Same', publishedAt: date })
    const c = await dedupKey({ guid: null, url: null, title: 'Other', publishedAt: date })
    expect(a).toBe(b)
    expect(a).toMatch(/^h:[0-9a-f]{64}$/)
    expect(a).not.toBe(c)
  })
})

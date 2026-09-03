import { describe, expect, test } from 'bun:test'
import {
  fromBase64Url,
  rewriteImages,
  signImageUrl,
  toBase64Url,
  verifyImageParams,
} from './images'

const secret = 'test-secret'

describe('images', () => {
  test('base64url round trip handles unicode', () => {
    const url = 'https://例子.example/图片.png?a=1&b=ü'
    expect(fromBase64Url(toBase64Url(url))).toBe(url)
  })

  test('sign and verify', async () => {
    const proxied = await signImageUrl('https://cdn.example/a.png', secret)
    const params = new URL(proxied, 'https://tela.test').searchParams
    const u = params.get('u') as string
    const s = params.get('s') as string
    expect(await verifyImageParams(u, s, secret)).toBe('https://cdn.example/a.png')
    expect(await verifyImageParams(u, `${s.slice(0, -1)}0`, secret)).toBeNull()
    expect(await verifyImageParams(u, s, 'other')).toBeNull()
    expect(
      await verifyImageParams(toBase64Url('ftp://x/y'), await (async () => s)(), secret),
    ).toBeNull()
  })

  test('rewrites only absolute http(s) image sources', async () => {
    const html =
      '<p><img src="https://a.example/x.png" alt="x"><img src="data:image/png;base64,AAA"></p>'
    const out = await rewriteImages(html, async (url) => `/img?u=${encodeURIComponent(url)}`)
    expect(out).toBe(
      '<p><img src="/img?u=https%3A%2F%2Fa.example%2Fx.png" alt="x" data-origin="a.example"><img src="data:image/png;base64,AAA"></p>',
    )
  })
})

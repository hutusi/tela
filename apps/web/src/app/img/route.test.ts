import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { signImageUrl } from '@tela/content/images'
import { GET } from './route'

// Dev-auth mode signs image URLs with a fixed secret, so the route can run without env.
const SECRET = 'dev-image-proxy-secret'

beforeEach(() => {
  process.env.TELA_DEV_AUTH = '1'
  delete process.env.IMAGE_PROXY_SECRET
})
afterEach(() => {
  delete process.env.TELA_DEV_AUTH
})

async function get(target: string): Promise<Response> {
  const signed = await signImageUrl(target, SECRET)
  return GET(new Request(`https://tela.test${signed}`))
}

describe('GET /img', () => {
  test('refuses private hosts even with a valid signature, before fetching', async () => {
    for (const target of [
      'http://127.0.0.1:9/x.png',
      'http://[fdaa::1]/x.png',
      'http://localhost/x.png',
      'http://169.254.169.254/latest/meta-data/',
      'http://[::ffff:10.0.0.1]/x.png',
    ]) {
      expect({ target, status: (await get(target)).status }).toEqual({ target, status: 403 })
    }
  })

  test('refuses a bad signature', async () => {
    const forged = await signImageUrl('https://blog.example/x.png', 'some-other-secret')
    expect((await GET(new Request(`https://tela.test${forged}`))).status).toBe(403)
  })
})

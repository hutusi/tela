import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { GET } from './route'

function get(query: string): Promise<Response> {
  return GET(new Request(`https://tela.test/api/reading/state${query}`))
}

afterEach(() => {
  delete process.env.TELA_DEV_AUTH
})

describe('GET /api/reading/state', () => {
  test('is 401 with no session, before any database work', async () => {
    expect((await get('?article=1&lang=en')).status).toBe(401)
  })

  describe('signed in', () => {
    beforeEach(() => {
      process.env.TELA_DEV_AUTH = '1'
    })

    test('rejects a bad article id or an unsupported language', async () => {
      const cases = ['', '?article=1', '?lang=en', '?article=0&lang=en', '?article=x&lang=en']
      for (const query of [...cases, '?article=1&lang=klingon', '?article=1.5&lang=en']) {
        expect({ query, status: (await get(query)).status }).toEqual({ query, status: 400 })
      }
    })
  })
})

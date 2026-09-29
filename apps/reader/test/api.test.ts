/**
 * The reader's one way to tela-api: every call names the account the tab holds, and the answers
 * that mean "this tab is out of date" reach the app whichever call met them.
 */
import { afterAll, afterEach, describe, expect, test } from 'bun:test'
import { MIN_CLIENT } from '@tela/sync'
import { AccountChanged, api, apiJson, bindApi, UpgradeRequired } from '../src/store/api'

const saved = globalThis.fetch
afterAll(() => {
  globalThis.fetch = saved
})

type Seen = { path: string; member: string | null; client: string | null }
function server(answer: () => Response) {
  const calls: Seen[] = []
  globalThis.fetch = (async (input: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers)
    calls.push({
      path: String(input),
      member: headers.get('x-tela-member'),
      client: headers.get('x-tela-client'),
    })
    return answer()
  }) as typeof fetch
  return calls
}

/** Bind `member` as the tab's account, counting what each handler hears. */
function bind(member: () => string | null) {
  const heard = { accountChanged: 0, upgrade: 0 }
  bindApi({
    member,
    accountChanged: () => void heard.accountChanged++,
    upgrade: () => void heard.upgrade++,
  })
  return heard
}
afterEach(() => {
  bindApi({ member: () => null, accountChanged() {}, upgrade() {} })
})

describe('every call to tela-api', () => {
  test('names the member, not only sync', async () => {
    bind(() => 'a')
    const calls = server(() => Response.json({ feedId: 1 }))
    await apiJson('/api/v1/feeds', { body: { feedUrl: 'https://blog.example/feed' } })
    await api('/api/v1/feeds/opml')
    await api('/api/v1/me')
    expect(calls.map((c) => c.member)).toEqual(['a', 'a', 'a'])
    expect(calls.map((c) => c.client)).toEqual([
      String(MIN_CLIENT),
      String(MIN_CLIENT),
      String(MIN_CLIENT),
    ])
  })

  test('names whoever the tab holds when it is made, and nobody while it holds no one', async () => {
    let held: string | null = null
    bind(() => held)
    const calls = server(() => Response.json({}))
    await api('/api/v1/me')
    held = 'b'
    await api('/api/v1/dashboard')
    // The engine names the account it asked for, whatever the tab holds by then.
    await api('/api/v1/sync?cursor=0', { member: 'a' })
    expect(calls.map((c) => c.member)).toEqual([null, 'b', 'a'])
  })

  test('account_changed from a call outside sync reaches the handler, once', async () => {
    const heard = bind(() => 'a')
    server(() => Response.json({ error: 'account_changed' }, { status: 409 }))
    // The settings page reads only the status: without the handler it would say "invalid handle".
    const saving = apiJson('/api/v1/profile', { method: 'PUT', body: { handle: 'alice' } })
    await expect(saving).rejects.toBeInstanceOf(AccountChanged)
    expect(heard).toEqual({ accountChanged: 1, upgrade: 0 })
  })

  test('upgrade from any call reaches the upgrade handler', async () => {
    const heard = bind(() => 'a')
    server(() => Response.json({ error: 'upgrade' }, { status: 409 }))
    await expect(api('/api/v1/search?q=x')).rejects.toBeInstanceOf(UpgradeRequired)
    expect(heard).toEqual({ accountChanged: 0, upgrade: 1 })
  })

  test('account_changed for an account the tab has since left is only late', async () => {
    let held: string | null = 'a'
    const heard = bind(() => held)
    let answer: (res: Response) => void = () => {}
    globalThis.fetch = (() =>
      new Promise<Response>((r) => {
        answer = r
      })) as unknown as typeof fetch
    const polling = api('/api/v1/claims/1')
    held = 'b' // signed in as b in this tab meanwhile
    answer(Response.json({ error: 'account_changed' }, { status: 409 }))
    await expect(polling).rejects.toBeInstanceOf(AccountChanged)
    expect(heard.accountChanged).toBe(0)
  })

  test('any other 409 is the page’s to read', async () => {
    const heard = bind(() => 'a')
    server(() => Response.json({ error: 'handle_taken' }, { status: 409 }))
    const { status, body } = await apiJson<{ error: string }>('/api/v1/profile', {
      method: 'PUT',
      body: {},
    })
    expect([status, body.error]).toEqual([409, 'handle_taken'])
    expect(heard).toEqual({ accountChanged: 0, upgrade: 0 })
  })
})

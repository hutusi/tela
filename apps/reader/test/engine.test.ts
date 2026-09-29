/**
 * The sync engine and the device store across tabs: one browser, one session cookie, and a tab
 * that may still hold the account another tab has just signed out of.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { memoryPersistence } from '../src/store/db'
import { SyncEngine } from '../src/store/engine'
import { LocalStore } from '../src/store/local'
import { NOW, profile, pull, sub } from './rows'

const saved = { fetch: globalThis.fetch, document: globalThis.document, window: globalThis.window }
const listeners = { addEventListener() {}, removeEventListener() {} }
beforeAll(() => {
  // Only the listener calls the engine makes when it starts and stops.
  Object.assign(globalThis, {
    document: { visibilityState: 'visible', ...listeners },
    window: listeners,
  })
})
afterAll(() => {
  Object.assign(globalThis, saved)
})

/** A fake tela-api that answers every call with `answer` and records what it was sent. */
function server(answer: () => Response) {
  const calls: { path: string; member: string | null }[] = []
  globalThis.fetch = (async (input: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers)
    calls.push({ path: String(input), member: headers.get('x-tela-member') })
    return answer()
  }) as typeof fetch
  return calls
}

const snapshot = pull(5, { profile: [profile], subscriptions: [sub(1)] }, true)

describe('another tab signing in as someone else', () => {
  test('every sync call names whose rows the device holds', async () => {
    const store = new LocalStore(memoryPersistence(), () => NOW)
    await store.setUser('a')
    await store.applyPull(snapshot)
    const calls = server(() => Response.json({ applied: [], rejected: [], seq: 5 }))
    const engine = new SyncEngine(store, {
      onSignedOut() {},
      onUpgrade() {},
      onAccountChanged() {},
    })
    store.mutate({ type: 'markRead', articleId: 1 })
    await engine.push()
    expect(calls.map((c) => c.member)).toEqual(['a', 'a'])
    expect(calls.map((c) => c.path.split('?')[0])).toEqual(['/api/v1/mutations', '/api/v1/sync'])
  })

  test('a refusal stops syncing and says so, and the change is not taken as sent', async () => {
    const store = new LocalStore(memoryPersistence(), () => NOW)
    await store.setUser('a')
    await store.applyPull(snapshot)
    server(() => Response.json({ error: 'account_changed' }, { status: 409 }))
    let changed = 0
    const engine = new SyncEngine(store, {
      onSignedOut() {},
      onUpgrade() {},
      onAccountChanged: () => void changed++,
    })
    store.mutate({ type: 'markRead', articleId: 1 })
    await engine.push()
    expect(changed).toBe(1)
    expect(store.unsent()).toHaveLength(1)
  })

  test("the stale tab forgets its account, and leaves the new account's stored copy alone", async () => {
    const storage = memoryPersistence()
    const stale = new LocalStore(storage, () => NOW)
    await stale.setUser('a')
    await stale.applyPull(snapshot)

    // The other tab signs in as b: its store replaces a's stored copy with b's.
    const other = new LocalStore(storage, () => NOW)
    await other.open()
    await other.setUser('b')
    await other.applyPull(snapshot)

    await stale.forgetAccount()
    expect(stale.hasData).toBe(false)
    expect(await storage.storedUserId()).toBe('b')
    expect((await storage.load()).rows).not.toBeNull()

    // Had nobody replaced it, a's stored copy goes as well.
    const alone = memoryPersistence()
    const only = new LocalStore(alone, () => NOW)
    await only.setUser('a')
    await only.applyPull(snapshot)
    await only.forgetAccount()
    expect(await alone.storedUserId()).toBeNull()
    expect((await alone.load()).rows).toBeNull()
  })
})

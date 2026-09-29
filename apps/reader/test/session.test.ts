import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { leaver } from '../src/leave'
import { distrust, distrustAfterEarlierBuild, distrusted, initialStatus } from '../src/session'
import { memoryPersistence, type Persistence } from '../src/store/db'
import { LocalStore } from '../src/store/local'
import { NOW, profile, pull, sub } from './rows'

const saved = globalThis.sessionStorage
beforeAll(() => {
  const held = new Map<string, string>()
  Object.assign(globalThis, {
    sessionStorage: {
      getItem: (k: string) => held.get(k) ?? null,
      setItem: (k: string, v: string) => void held.set(k, v),
      removeItem: (k: string) => void held.delete(k),
    },
  })
})
afterAll(() => {
  Object.assign(globalThis, { sessionStorage: saved })
})

describe('a tab that left an account it could not forget', () => {
  test('does not trust that copy on its next boot, and only on that one', () => {
    distrust('a')
    // Another account's copy is not what it left.
    expect(distrusted('b')).toBe(false)
    distrust('a')
    expect(distrusted('a')).toBe(true)
    // Asked once: the boot after that trusts a copy again, so a lost record cannot lock it out.
    expect(distrusted('a')).toBe(false)
  })
})

/** A member's copy, on storage that may refuse to be forgotten. */
async function held(storage: Persistence) {
  const store = new LocalStore(storage, () => NOW)
  await store.open()
  await store.setUser('a')
  await store.applyPull(pull(5, { profile: [profile], subscriptions: [sub(1)] }, true), store.epoch)
  return store
}
const reopened = async (storage: Persistence) => {
  const store = new LocalStore(storage, () => NOW)
  await store.open()
  return store
}

describe('leaving an account', () => {
  test('a tab whose storage will not forget boots asking who is signed in, and only once', async () => {
    const inner = memoryPersistence()
    const refusing: Persistence = { ...inner, release: () => Promise.reject(new Error('disk')) }
    const store = await held(refusing)
    const went: string[] = []
    await leaver({ stop() {}, store, go: (path) => void went.push(path) })()
    expect(went).toEqual(['/'])
    // The copy is still a's, and it must not be trusted: showing it would be refused again.
    const next = await reopened(refusing)
    expect(next.hasData).toBe(true)
    expect(initialStatus(next)).toBe('unknown')
    // The boot after that trusts a copy again, so a record left behind cannot lock the tab out.
    expect(initialStatus(await reopened(refusing))).toBe('member')
  })

  test('a tab that did forget boots as nobody, and leaves once however often it is told', async () => {
    const storage = memoryPersistence()
    const store = await held(storage)
    let stopped = 0
    const went: string[] = []
    const leave = leaver({ stop: () => void stopped++, store, go: (path) => void went.push(path) })
    await Promise.all([leave(), leave()])
    expect([stopped, went]).toEqual([1, ['/']])
    const next = await reopened(storage)
    expect(next.hasData).toBe(false)
    expect(initialStatus(next)).toBe('unknown')
  })

  test('an earlier build having run on this device makes this boot ask first', async () => {
    const storage = memoryPersistence()
    await held(storage)
    const next = await reopened(storage)
    await distrustAfterEarlierBuild(next, async () => false)
    expect(initialStatus(next)).toBe('member')
    const after = await reopened(storage)
    await distrustAfterEarlierBuild(after, async () => true)
    expect(initialStatus(after)).toBe('unknown')
  })
})

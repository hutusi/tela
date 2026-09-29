import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { distrust, distrusted } from '../src/session'

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

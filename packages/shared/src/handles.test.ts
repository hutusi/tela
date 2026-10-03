import { describe, expect, test } from 'bun:test'
import { isValidHandle, RESERVED_HANDLES } from './handles'

describe('handles', () => {
  test('are 3 to 30 lowercase letters, digits or underscores', () => {
    expect(isValidHandle('hutusi')).toBe(true)
    expect(isValidHandle('u_0123456789')).toBe(true)
    expect(isValidHandle('a_1')).toBe(true)
    expect(isValidHandle('x'.repeat(30))).toBe(true)
    expect(isValidHandle('ab')).toBe(false)
    expect(isValidHandle('x'.repeat(31))).toBe(false)
    expect(isValidHandle('Hutusi')).toBe(false)
    expect(isValidHandle('hu-tusi')).toBe(false)
    expect(isValidHandle('hü_tusi')).toBe(false)
    expect(isValidHandle(' hutusi')).toBe(false)
  })

  test("the app's own paths are taken, the front door's among them", () => {
    for (const word of ['admin', 'settings', 'login', 'about', 'discover', 'following']) {
      expect(isValidHandle(word)).toBe(false)
    }
    for (const word of ['writers', 'join', 'invites', 'privacy', 'terms']) {
      expect(RESERVED_HANDLES.has(word)).toBe(true)
      expect(isValidHandle(word)).toBe(false)
    }
  })
})

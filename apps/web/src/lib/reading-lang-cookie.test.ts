import { describe, expect, test } from 'bun:test'
import { readingLangCookie, readingLangFromCookie } from './reading-lang-cookie'

const user = '11111111-1111-4111-8111-111111111111'
const other = '22222222-2222-4222-8222-222222222222'

describe('reading language cookie', () => {
  test('round-trips a language for the member it was written for', () => {
    expect(readingLangFromCookie(readingLangCookie(user, 'zh-Hans'), user)).toBe('zh-Hans')
  })

  test('is ignored for a different member, so a shared browser cannot leak a setting', () => {
    expect(readingLangFromCookie(readingLangCookie(other, 'zh-Hans'), user)).toBeNull()
  })

  test('is ignored when it holds nothing usable', () => {
    for (const value of [undefined, '', 'zh-Hans', `${user}:`, `${user}:klingon`, ':zh-Hans']) {
      expect({ value, lang: readingLangFromCookie(value, user) }).toEqual({ value, lang: null })
    }
  })
})

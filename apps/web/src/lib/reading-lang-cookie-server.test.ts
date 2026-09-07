import { describe, expect, test } from 'bun:test'
import { READING_LANG_COOKIE_OPTIONS } from './reading-lang-cookie'
import { seedReadingLangCookie } from './reading-lang-cookie-server'

const user = '11111111-1111-4111-8111-111111111111'

describe('seedReadingLangCookie', () => {
  test('writes the profile language with the shared cookie policy', async () => {
    const writes: unknown[][] = []
    const seeded = await seedReadingLangCookie(user, (...args) => writes.push(args), {
      readReadingLang: async () => 'zh-Hans',
    })

    expect(seeded).toBe(true)
    expect(writes).toEqual([['tela_reading_lang', `${user}:zh-Hans`, READING_LANG_COOKIE_OPTIONS]])
  })

  test('does not write an invalid profile value', async () => {
    const writes: unknown[][] = []
    const seeded = await seedReadingLangCookie(user, (...args) => writes.push(args), {
      readReadingLang: async () => 'klingon',
    })

    expect(seeded).toBe(false)
    expect(writes).toEqual([])
  })

  test('never blocks sign-in when the profile lookup fails', async () => {
    const warnings: unknown[][] = []
    const seeded = await seedReadingLangCookie(user, () => undefined, {
      readReadingLang: async () => {
        throw new Error('database unavailable')
      },
      warn: (...args) => warnings.push(args),
    })

    expect(seeded).toBe(false)
    expect(warnings).toHaveLength(1)
  })
})

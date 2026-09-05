import { describe, expect, test } from 'bun:test'
import { parseAuthReturn, TOKEN_HASH_TYPES } from './auth-return'

const at = (query: string) => parseAuthReturn(new URL(`https://tela.test/auth/callback${query}`))

describe('parseAuthReturn', () => {
  test('a PKCE code from OAuth, with the destination sanitized', () => {
    expect(at('?code=abc&next=/sites/1')).toEqual({ kind: 'code', code: 'abc', next: '/sites/1' })
    expect(at('?code=abc&next=https://evil.test')).toEqual({
      kind: 'code',
      code: 'abc',
      next: '/reading',
    })
  })

  test('a token hash from an email link, for the email OTP types only', () => {
    for (const type of TOKEN_HASH_TYPES) {
      expect(at(`?token_hash=h&type=${type}`)).toEqual({
        kind: 'token_hash',
        tokenHash: 'h',
        type,
        next: '/reading',
      })
    }
    expect(at('?token_hash=h&type=sms')).toEqual({ kind: 'none', next: '/reading' })
    expect(at('?token_hash=h')).toEqual({ kind: 'none', next: '/reading' })
  })

  test('nothing usable', () => {
    expect(at('')).toEqual({ kind: 'none', next: '/reading' })
  })
})

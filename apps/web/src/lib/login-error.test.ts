import { describe, expect, test } from 'bun:test'
import { loginErrorKey } from './login-error'

describe('loginErrorKey', () => {
  test('the private-beta refusal is the only thing that says "no account"', () => {
    // shouldCreateUser: false against an address GoTrue has never seen.
    expect(
      loginErrorKey({ code: 'otp_disabled', status: 422, message: 'Signups not allowed for otp' }),
    ).toBe('not_invited')
  })

  test('a disabled email provider is a server fault, not the reader’s', () => {
    // The regression: same 422, and a member with a working account was told they had none.
    // Captured from production while [auth.email] enable_signup was false.
    const error = {
      code: 'email_provider_disabled',
      status: 422,
      message: 'Email logins are disabled',
    }
    expect(loginErrorKey(error)).toBe('not_configured')
    expect(loginErrorKey(error)).not.toBe('not_invited')
  })

  test('no other 422 may claim the address has no account', () => {
    for (const code of [
      'validation_failed',
      'email_address_invalid',
      'bad_json',
      'unexpected_failure',
    ]) {
      expect(loginErrorKey({ code, status: 422, message: 'nope' })).toBe('send_failed')
    }
    // Status alone carries no meaning here — this is what the old heuristic got wrong.
    expect(loginErrorKey({ status: 422, message: 'Unprocessable Entity' })).toBe('send_failed')
  })

  test('rate limiting and transport failures are retryable, not identity claims', () => {
    expect(loginErrorKey({ code: 'over_email_send_rate_limit', status: 429 })).toBe('send_failed')
    expect(loginErrorKey({ status: 500, message: 'Error sending confirmation email' })).toBe(
      'send_failed',
    )
  })

  test('falls back to the message only for GoTrue replies with no code', () => {
    expect(loginErrorKey({ status: 422, message: 'Signups not allowed for otp' })).toBe(
      'not_invited',
    )
    expect(loginErrorKey({ status: 422, message: 'Email logins are disabled' })).toBe('send_failed')
    expect(loginErrorKey({})).toBe('send_failed')
  })
})

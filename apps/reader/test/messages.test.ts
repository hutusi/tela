import { describe, expect, test } from 'bun:test'
import en from '../messages/en.json'
import zhHans from '../messages/zh-Hans.json'

/** Every string's path in a catalogue, such as `login.errors.rate_limited`. */
function keys(messages: object, prefix = ''): string[] {
  return Object.entries(messages).flatMap(([key, value]) =>
    value !== null && typeof value === 'object'
      ? keys(value, `${prefix}${key}.`)
      : [`${prefix}${key}`],
  )
}

describe('message catalogues', () => {
  // The type of `MESSAGES` catches a key missing from zh-Hans, never one only zh-Hans has.
  test('en and zh-Hans have the same keys', () => {
    expect(keys(zhHans).sort()).toEqual(keys(en).sort())
  })
})

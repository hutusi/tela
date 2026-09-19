import { describe, expect, test } from 'bun:test'
import {
  READING_MODE_COOKIE,
  readingModeDocumentCookie,
  readingModeFromCookie,
} from './reading-mode-cookie'

describe('reading mode cookie', () => {
  test('round-trips every mode', () => {
    for (const mode of ['side', 'trans', 'orig'] as const) {
      expect(readingModeFromCookie(mode)).toBe(mode)
    }
  })

  test('serializes with a path, an expiry and lax same-site', () => {
    expect(readingModeDocumentCookie('orig')).toBe(
      `${READING_MODE_COOKIE}=orig; Path=/; Max-Age=31536000; SameSite=Lax`,
    )
  })

  test('garbage and absence read as no preference, not as the default', () => {
    // null rather than 'side', so a caller can tell "never chose" from "chose side by side".
    expect(readingModeFromCookie(undefined)).toBeNull()
    expect(readingModeFromCookie('')).toBeNull()
    expect(readingModeFromCookie('sideways')).toBeNull()
  })
})

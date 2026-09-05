import { describe, expect, test } from 'bun:test'
import { safeNext } from './redirect'

describe('safeNext', () => {
  test('keeps same-origin paths, including query and hash', () => {
    expect(safeNext('/reading', '/x')).toBe('/reading')
    expect(safeNext('/reading?feed=3&article=9#top', '/x')).toBe('/reading?feed=3&article=9#top')
    expect(safeNext('/s/12', '/x')).toBe('/s/12')
  })

  test('falls back for protocol-relative, backslash, and absolute targets', () => {
    expect(safeNext('//attacker.example', '/reading')).toBe('/reading')
    expect(safeNext('//attacker.example/path', '/reading')).toBe('/reading')
    expect(safeNext('/\\attacker.example', '/reading')).toBe('/reading')
    expect(safeNext('https://attacker.example', '/reading')).toBe('/reading')
    expect(safeNext('javascript:alert(1)', '/reading')).toBe('/reading')
    expect(safeNext('reading', '/reading')).toBe('/reading')
  })

  test('falls back for missing or non-string values', () => {
    expect(safeNext(null, '/discover')).toBe('/discover')
    expect(safeNext(undefined, '/discover')).toBe('/discover')
    expect(safeNext('', '/discover')).toBe('/discover')
    expect(safeNext(42, '/discover')).toBe('/discover')
  })

  test('normalizes dot segments and control characters', () => {
    expect(safeNext('/reading/../settings', '/x')).toBe('/settings')
    expect(safeNext('/reading\r\nSet-Cookie: a=b', '/x')).toBe('/readingSet-Cookie:%20a=b')
  })
})

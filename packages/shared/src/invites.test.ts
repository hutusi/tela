import { describe, expect, test } from 'bun:test'
import {
  groupInviteCode,
  INVITE_ALLOWANCE,
  INVITE_ALPHABET,
  INVITE_CODE_LENGTH,
  isOperatorCode,
  normalizeInviteCode,
} from './invites'

const MEMBER = 'ABCDEFGHJKMN'

describe('invite codes', () => {
  test('a member invites five, with codes of about 59 bits from symbols nobody misreads', () => {
    expect(INVITE_ALLOWANCE).toBe(5)
    expect(new Set(INVITE_ALPHABET).size).toBe(30)
    for (const symbol of '01ILOU') expect(INVITE_ALPHABET).not.toContain(symbol)
    expect(INVITE_CODE_LENGTH * Math.log2(INVITE_ALPHABET.length)).toBeGreaterThan(58)
  })

  test('normalize to capitals without separators, whatever was typed', () => {
    expect(normalizeInviteCode('abcd-efgh-jkmn')).toBe(MEMBER)
    expect(normalizeInviteCode(' ABCD EFGH\tJKMN ')).toBe(MEMBER)
    expect(normalizeInviteCode('ABCD–EFGH—JKMN')).toBe(MEMBER)
    // A Chinese input method: full-width letters, a full-width dash and an ideographic space.
    expect(normalizeInviteCode('ＡＢＣＤ－ＥＦＧＨ　ＪＫＭＮ')).toBe(MEMBER)
    expect(normalizeInviteCode('welcome')).toBe('WELCOME')
    expect(normalizeInviteCode('tela 2026')).toBe('TELA2026')
  })

  test('refuse what cannot be a code', () => {
    expect(normalizeInviteCode('')).toBeNull()
    expect(normalizeInviteCode('abc')).toBeNull()
    expect(normalizeInviteCode('A'.repeat(33))).toBeNull()
    expect(normalizeInviteCode(`${'A'.repeat(32)}${' '.repeat(100)}`)).toBeNull()
    expect(normalizeInviteCode('TELA!')).toBeNull()
    expect(normalizeInviteCode('tela_2026')).toBeNull()
    expect(normalizeInviteCode('héllo')).toBeNull()
    expect(normalizeInviteCode(undefined)).toBeNull()
    expect(normalizeInviteCode(12345)).toBeNull()
  })

  test("only a member's shape is a member's code", () => {
    expect(isOperatorCode(MEMBER)).toBe(false)
    expect(isOperatorCode('WELCOME')).toBe(true)
    expect(isOperatorCode('ABCDEFGHJKM')).toBe(true)
    expect(isOperatorCode('ABCDEFGHJKMNP')).toBe(true)
    // Twelve symbols, but an O is never drawn.
    expect(isOperatorCode('ABCDEFGHJKMO')).toBe(true)
  })

  test("group a member's code in fours, and leave the operator's word alone", () => {
    expect(groupInviteCode(MEMBER)).toBe('ABCD-EFGH-JKMN')
    expect(groupInviteCode('WELCOME2026')).toBe('WELCOME2026')
    expect(normalizeInviteCode(groupInviteCode(MEMBER))).toBe(MEMBER)
  })
})

/**
 * Invite codes (ADR 0034). A member's codes are drawn by tela-api from `INVITE_ALPHABET`; the
 * operator's are words of their own choosing. Both are stored normalized, shown grouped, and
 * normalized again on the way in, so a code survives being read out, retyped or pasted with its
 * dashes.
 */

/** People each member may invite, ever: a code counts while unrevoked, and for good once used. */
export const INVITE_ALLOWANCE = 5

/**
 * The symbols of a member's code: digits and capitals without 0, 1, I, L, O and U, so no symbol
 * reads as another and a code seldom spells a word.
 */
export const INVITE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ'

/** Symbols in a member's code: 30^12, about 59 bits. */
export const INVITE_CODE_LENGTH = 12

/** Any stored code, a member's or the operator's. */
const CODE = /^[A-Z0-9]{4,32}$/
const MEMBER_CODE = new RegExp(`^[${INVITE_ALPHABET}]{${INVITE_CODE_LENGTH}}$`)
/** Spaces and every kind of dash, which people put between groups. */
const SEPARATORS = /[\s‐-―−-]/g

/**
 * A code as stored, from whatever was typed or pasted: full-width forms folded (a Chinese input
 * method types `ＡＢＣＤ`), capitals, separators dropped. Null when what is left cannot be a code,
 * so nothing is looked up for it.
 */
export function normalizeInviteCode(input: unknown): string | null {
  // Far longer than any code written out in groups.
  if (typeof input !== 'string' || input.length > 100) return null
  const code = input.normalize('NFKC').toUpperCase().replace(SEPARATORS, '')
  return CODE.test(code) ? code : null
}

/**
 * Whether a stored code is the operator's. Every member code has the one shape tela-api draws, so
 * the operator's text may not take it: the two never collide, and the shape alone says whose a
 * code is.
 */
export function isOperatorCode(code: string): boolean {
  return !MEMBER_CODE.test(code)
}

/**
 * A code as shown: a member's in groups of four (`ABCD-EFGH-JKMN`), easier to read out and still a
 * `?code=` without escaping; the operator's word as written.
 */
export function groupInviteCode(code: string): string {
  return isOperatorCode(code) ? code : code.replace(/(.{4})(?=.)/g, '$1-')
}

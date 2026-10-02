import { describe, expect, test } from 'bun:test'
import { inviteLink } from '../src/lib/account-api'

describe('an invite link', () => {
  test("carries a member's code in groups of four, which the join sheet reads back", () => {
    expect(inviteLink('ABCDEFGHJKMN', 'https://tela.example')).toBe(
      'https://tela.example/join?code=ABCD-EFGH-JKMN',
    )
  })

  test("carries an operator's word as written", () => {
    expect(inviteLink('WELCOME2026', 'https://tela.example')).toBe(
      'https://tela.example/join?code=WELCOME2026',
    )
  })
})

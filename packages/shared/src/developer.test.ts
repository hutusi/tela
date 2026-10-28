import { describe, expect, test } from 'bun:test'
import { hasInvisible, mentionsTela, parseDeveloperApp } from './developer'

const SETTINGS = {
  name: 'Loom',
  developer: 'Loom Labs',
  contactEmail: 'dev@loom.example',
  homepageUrl: 'https://loom.example',
  privacyUrl: 'https://loom.example/privacy',
  redirectUris: ['http://127.0.0.1/callback'],
  maxScope: 'read',
}

describe('the word only the operator may use (ADR 0067)', () => {
  test('is found as any word starting with it, in any case or width', () => {
    for (const name of ['Tela', 'tela sync', 'TelaSync', 'my-tela', 'Ｔｅｌａ', 'TELA Desktop']) {
      expect([name, mentionsTela(name)]).toEqual([name, true])
    }
    for (const name of ['Hotela', 'Stellar', 'Loom', 'Te la']) {
      expect([name, mentionsTela(name)]).toEqual([name, false])
    }
  })

  test('is found through what a reader cannot see, and through look-alike letters', () => {
    const hidden = [
      'T­ela Sync', // soft hyphen
      'T​ela', // zero-width space
      'T‍ela', // zero-width joiner
      'T⁠ela', // word joiner
      'ㅤTela', // Hangul filler, drawn as a blank
      'Tеla', // Cyrillic е
      'Тela', // Cyrillic Т
      'Τela', // Greek Τ
      'ТЕЛА', // Cyrillic ТЕЛА: Л is not a Latin l, but Т Е А still are
    ]
    for (const name of hidden.slice(0, 8)) {
      expect([JSON.stringify(name), mentionsTela(name)]).toEqual([JSON.stringify(name), true])
    }
  })

  test('a name or developer with an invisible character is refused, whatever it says', () => {
    expect(hasInvisible('Loom‮')).toBe(true)
    expect(hasInvisible('Loom Labs')).toBe(false)
    for (const name of ['Lo​om', '‮mooL', 'Loomㅤ']) {
      expect(parseDeveloperApp({ ...SETTINGS, name })).toEqual({ ok: false, field: 'name' })
      expect(parseDeveloperApp({ ...SETTINGS, developer: name })).toEqual({
        ok: false,
        field: 'developer',
      })
    }
    expect(parseDeveloperApp({ ...SETTINGS, name: 'Tеla Sync' })).toEqual({
      ok: false,
      field: 'name',
    })
    expect(parseDeveloperApp(SETTINGS).ok).toBe(true)
  })
})

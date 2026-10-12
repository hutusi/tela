/** Which page a Settings address shows, on a phone (Tela Mobile 13) and from `md` up. */
import { describe, expect, test } from 'bun:test'
import { hrefOf, SECTIONS, settingsView } from '../src/pages/settings'

describe('a Settings address', () => {
  test("bare, is the list on a phone and goes to Profile's own address from md up", () => {
    expect(settingsView(undefined, '', true)).toEqual({ kind: 'list' })
    // Never Profile in place: a form at the address whose page turns on the width would lose an
    // edit when a phone turned across md.
    // Marked as the list's entry, which a phone that comes back to it shows as the list again.
    expect(settingsView(undefined, '', false)).toEqual({
      kind: 'redirect',
      to: '/settings/profile',
      wasList: true,
    })
  })

  test('Profile has its own, which is Profile at every width and what its links name', () => {
    expect(hrefOf('profile')).toBe('/settings/profile')
    for (const phone of [true, false]) {
      expect(settingsView('profile', '', phone)).toEqual({ kind: 'section', section: 'profile' })
    }
  })

  test('naming a section is that section at every width', () => {
    for (const section of SECTIONS) {
      expect(hrefOf(section)).toBe(`/settings/${section}`)
      for (const phone of [true, false]) {
        expect(settingsView(section, '', phone)).toEqual({ kind: 'section', section })
      }
    }
  })

  test("a link's return from Google or GitHub goes to Account, the list or not", () => {
    for (const phone of [true, false]) {
      expect(settingsView(undefined, '?linked=github', phone)).toEqual({
        kind: 'redirect',
        to: '/settings/account?linked=github',
      })
      expect(settingsView(undefined, '?error=account_already_linked', phone)).toEqual({
        kind: 'redirect',
        to: '/settings/account?error=account_already_linked',
      })
    }
    // Only bare /settings is where tela-api sends it back.
    expect(settingsView('reading', '?linked=github', true)).toEqual({
      kind: 'section',
      section: 'reading',
    })
  })

  test('one that names no section goes to /settings', () => {
    for (const asked of ['nothing-here', 'Profile', '']) {
      for (const phone of [true, false]) {
        expect(settingsView(asked, '', phone)).toEqual({ kind: 'redirect', to: '/settings' })
      }
    }
  })
})

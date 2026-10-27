import { describe, expect, test } from 'bun:test'
import { APP_NAME_MAX, APP_REDIRECTS_MAX, APP_URL_MAX } from '../apps'
import { parseAppSettings, redirectKind } from './apps'

const good = {
  name: 'Loom',
  developer: 'Loom Labs',
  contactEmail: 'dev@loom.example',
  homepageUrl: 'https://loom.example',
  privacyUrl: 'https://loom.example/privacy',
  redirectUris: ['http://127.0.0.1/callback', 'com.loom.desktop:/oauth'],
  maxScope: 'write',
  allowEmail: false,
  owner: '@Mara',
  perMemberPerMin: null,
  perAppPerMin: 0,
  maxConnections: 500,
}

describe('a redirect an app may register (RFC 8252)', () => {
  test('a loopback address over http, with or without a port', () => {
    expect(redirectKind('http://127.0.0.1/callback')).toBe('loopback')
    expect(redirectKind('http://127.0.0.1:8080/callback')).toBe('loopback')
    expect(redirectKind('http://[::1]:5000/cb?x=1')).toBe('loopback')
  })

  test('a reverse-DNS scheme the developer controls', () => {
    expect(redirectKind('com.example.app:/oauth')).toBe('scheme')
    expect(redirectKind('io.loom.desktop:/')).toBe('scheme')
  })

  test('never localhost, plain http elsewhere, https, a fragment, or a URI a browser rewrites', () => {
    for (const uri of [
      'http://localhost/cb',
      'http://localhost:8080/cb',
      'http://example.com/cb',
      'https://example.com/cb',
      'http://127.1/cb',
      'http://127.0.0.1',
      'http://127.0.0.1/cb#frag',
      'http://user@127.0.0.1/cb',
      'example:/cb',
      'Com.Example.App:/cb',
      'com.example.app://cb',
      'javascript:alert(1)',
      `http://127.0.0.1/${'x'.repeat(APP_URL_MAX)}`,
    ]) {
      expect({ uri, kind: redirectKind(uri) }).toEqual({ uri, kind: null })
    }
  })
})

describe('an app’s settings', () => {
  test('are tidied: trimmed, a handle without its @, empty addresses as none', () => {
    const parsed = parseAppSettings({ ...good, name: '  Loom ', homepageUrl: '' })
    expect(parsed).toEqual({
      ok: true,
      value: { ...good, name: 'Loom', homepageUrl: null, owner: 'mara', maxScope: 'write' },
    } as never)
  })

  test('name the first field that is wrong', () => {
    const wrong = (over: Record<string, unknown>) => {
      const parsed = parseAppSettings({ ...good, ...over })
      return parsed.ok ? null : parsed.field
    }
    expect(wrong({ name: '' })).toBe('name')
    expect(wrong({ name: 'x'.repeat(APP_NAME_MAX + 1) })).toBe('name')
    expect(wrong({ developer: '   ' })).toBe('developer')
    expect(wrong({ contactEmail: 'nobody' })).toBe('contactEmail')
    // Linked from the consent page: https only, never a script.
    expect(wrong({ homepageUrl: 'javascript:alert(1)' })).toBe('homepageUrl')
    expect(wrong({ privacyUrl: 'http://loom.example/privacy' })).toBe('privacyUrl')
    expect(wrong({ redirectUris: [] })).toBe('redirectUris')
    expect(wrong({ redirectUris: ['http://localhost/cb'] })).toBe('redirectUris')
    expect(wrong({ redirectUris: ['http://127.0.0.1/a', 'http://127.0.0.1/a'] })).toBe(
      'redirectUris',
    )
    expect(
      wrong({
        redirectUris: Array.from({ length: APP_REDIRECTS_MAX + 1 }, (_, i) => `com.a.b:/${i}`),
      }),
    ).toBe('redirectUris')
    expect(wrong({ maxScope: 'admin' })).toBe('maxScope')
    expect(wrong({ allowEmail: 'yes' })).toBe('allowEmail')
    expect(wrong({ owner: 'no spaces' })).toBe('owner')
    expect(wrong({ perMemberPerMin: -1 })).toBe('perMemberPerMin')
    expect(wrong({ perAppPerMin: 1.5 })).toBe('perAppPerMin')
    expect(wrong({ maxConnections: '7' })).toBe('maxConnections')
    expect(parseAppSettings(null)).toEqual({ ok: false, field: 'name' })
  })
})

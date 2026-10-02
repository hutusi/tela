import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { discoverApiPath, discoverHref, parseDiscoverParams } from '../src/lib/discover-href'
import { canonicalReadingHref, parseReadingParams, readingHref } from '../src/lib/href'
import { addError } from '../src/lib/opml'
import {
  codeError,
  errorReturn,
  joinError,
  loginPath,
  mailLink,
  providerError,
  safeNext,
  withoutDoor,
} from '../src/lib/use-sign-in'
import { claimError } from '../src/pages/claim'
import { handleFrom } from '../src/pages/profile'
import { publicRoute } from '../src/ssr'

describe('reading URLs', () => {
  test('leave defaults out, and compare by what they mean', () => {
    expect(readingHref({ filter: 'all', feedId: 3, articleId: 7, mode: 'side' })).toBe(
      '/reading?feed=3&article=7',
    )
    expect(readingHref({ articleId: 7, mode: 'orig' })).toBe('/reading?article=7&mode=orig')
    expect(readingHref({ mode: 'orig' })).toBe('/reading')
    expect(canonicalReadingHref('?mode=side&article=7')).toBe(canonicalReadingHref('?article=7'))
    expect(parseReadingParams(new URLSearchParams('filter=nope&feed=-1&article=x'))).toEqual({
      filter: 'all',
      feedId: null,
      articleId: null,
      mode: null,
    })
  })
})

describe('Discover URLs', () => {
  test('keep a known topic and a language tag, in one order', () => {
    const params = parseDiscoverParams(new URLSearchParams('lang=ja&topic=tech&utm=x'))
    expect(params).toEqual({ topic: 'tech', lang: 'ja' })
    expect(discoverHref(params)).toBe('/discover?topic=tech&lang=ja')
    expect(discoverApiPath(params)).toBe('/api/v1/public/discover?topic=tech&lang=ja')
    expect(parseDiscoverParams(new URLSearchParams('topic=nope&lang=<x>'))).toEqual({
      topic: null,
      lang: null,
    })
  })
})

describe('public pages at the edge', () => {
  test('are Discover, a blog by id, a profile by handle and the info pages, and nothing else', () => {
    const route = (path: string) => publicRoute(new URL(path, 'https://tela.test'))
    expect(route('/discover?topic=tech')).toMatchObject({
      kind: 'discover',
      api: '/api/v1/public/discover?topic=tech',
    })
    expect(route('/s/12')).toMatchObject({
      kind: 'site',
      siteId: 12,
      api: '/api/v1/public/sites/12',
    })
    expect(route('/@Reader_1')).toMatchObject({
      kind: 'profile',
      handle: 'reader_1',
      tab: null,
      key: '/api/v1/public/profiles/reader_1',
    })
    // A profile's tabs are one endpoint and two pages, cached apart; an unknown tab is the first.
    expect(route('/@reader_1?tab=liked')).toMatchObject({
      api: '/api/v1/public/profiles/reader_1',
      key: '/api/v1/public/profiles/reader_1?tab=liked',
    })
    expect(route('/@reader_1?tab=nope')).toMatchObject({ tab: null })
    // About, Privacy and Terms need nothing from tela-api, and are cached by page.
    for (const page of ['about', 'privacy', 'terms'] as const)
      expect(route(`/${page}`)).toEqual({ kind: 'info', page, api: null, key: `/info/${page}` })
    for (const path of [
      '/s/12/x',
      '/s/abc',
      '/@',
      '/@a/b',
      '/reading',
      '/about/',
      '/about/x',
      '/About',
      '/info/about',
    ])
      expect(route(path)).toBeNull()
    expect(handleFrom('/%40someone')).toBe('someone')
  })

  test("the front page is a visitor's, one page for each title mode, and nothing beside it", () => {
    const route = (path: string) => publicRoute(new URL(path, 'https://tela.test'))
    expect(route('/')).toMatchObject({
      kind: 'landing',
      titles: 'original',
      api: '/api/v1/public/front',
      key: '/',
      visitorsOnly: true,
      alwaysExists: true,
    })
    expect(route('/?titles=translated&utm_source=x')).toMatchObject({
      titles: 'translated',
      api: '/api/v1/public/front',
      key: '/?titles=translated',
    })
    // Anything else in the address is the default mode, under the default key.
    expect(route('/?titles=nope')).toMatchObject({ titles: 'original', key: '/' })
    // SPA-only: a code in `/join?code=` must never reach a cached page, or Workers Logs.
    for (const path of ['/join', '/join?code=ABCD', '/writers', '/__tela/shell'])
      expect(route(path)).toBeNull()
  })

  test('every public page runs the Worker first, or the edge never renders it', () => {
    const config = JSON.parse(
      readFileSync(join(import.meta.dir, '..', 'wrangler.jsonc'), 'utf8')
        .split('\n')
        .filter((line) => !line.trim().startsWith('//'))
        .join('\n'),
    ) as { assets: { run_worker_first: string[] } }
    const patterns = config.assets.run_worker_first
    const runsFirst = (path: string) =>
      patterns.some((p) => (p.endsWith('*') ? path.startsWith(p.slice(0, -1)) : path === p))
    const pages = ['/', '/?titles=translated', '/discover?topic=tech', '/s/12', '/@reader_1']
    for (const page of pages) {
      const url = new URL(page, 'https://tela.test')
      expect(publicRoute(url)).not.toBeNull()
      expect(runsFirst(url.pathname)).toBe(true)
    }
    // The shell the service worker keeps is fetched from a path the Worker never runs for.
    expect(runsFirst('/__tela/shell')).toBe(false)
    expect(patterns).not.toContain('/*')
  })
})

describe('answers the pages turn into messages', () => {
  test('sign-in returns only to this site', () => {
    expect(safeNext('/s/1')).toBe('/s/1')
    for (const next of [null, 'https://evil.example', '//evil.example', '/\\evil.example']) {
      expect(safeNext(next)).toBe('/reading')
    }
  })
  test("a mailed link's code is read, and nothing but where to go next stays in the address", () => {
    const link = (query: string) => new URLSearchParams(query)
    expect(mailLink(link('email=a%40x.test&otp=123456&next=%2Fsettings'))).toEqual({
      email: 'a@x.test',
      otp: '123456',
      reset: false,
    })
    expect(mailLink(link('reset=1&email=a%40x.test&otp=123456'))).toEqual({
      email: 'a@x.test',
      otp: '123456',
      reset: true,
    })
    for (const query of ['email=a%40x.test', 'otp=123456', 'email=&otp=123456', 'next=%2Fs%2F1'])
      expect(mailLink(link(query))).toBeNull()
    expect(loginPath(link('email=a%40x.test&otp=123456&next=%2Fsettings'))).toBe(
      '/login?next=%2Fsettings',
    )
    expect(loginPath(link('reset=1&email=a%40x.test&otp=123456'))).toBe('/login')
    expect(loginPath(link('email=a%40x.test&otp=1&next=%2F%2Fevil.example'))).toBe(
      '/login?next=%2Freading',
    )
  })
  test("the gate's refusal of a code is never called a wrong code", () => {
    expect(codeError(429, undefined)).toBe('rate_limited')
    expect(codeError(403, 'INVITE_REQUIRED')).toBe('not_invited')
    expect(codeError(400, 'INVITE_USED')).toBe('invite_used')
    expect(codeError(400, 'INVALID_OTP')).toBe('bad_code')
    expect(codeError(400, undefined)).toBe('bad_code')
  })
  test("a join's answers", () => {
    expect(joinError(400, 'invalid_code')).toBe('invalid_code')
    expect(joinError(400, 'invalid_email')).toBe('invalid_email')
    expect(joinError(409, 'code_used')).toBe('code_used')
    expect(joinError(429, 'rate_limited')).toBe('rate_limited')
    expect(joinError(500, undefined)).toBe('send_failed')
  })
  test("a provider's refusal, in either case, and any code nobody listed", () => {
    expect(providerError('invite_required')).toBe('not_invited')
    expect(providerError('INVITE_REQUIRED')).toBe('not_invited')
    expect(providerError('invite_unavailable')).toBe('invite_used')
    expect(providerError('account_not_linked')).toBe('provider_unlinked')
    expect(providerError('email_not_verified')).toBe('provider_unlinked')
    expect(providerError('email_not_found')).toBe('provider_no_email')
    expect(providerError('access_denied')).toBe('provider_cancelled')
    expect(providerError('state_mismatch')).toBe('provider_expired')
    expect(providerError('unable_to_create_user')).toBe('provider_failed')
    expect(providerError('something_new')).toBe('provider_failed')
  })
  test('a refused provider comes back to the page it started on, and leaves it as it was', () => {
    const back = errorReturn('/discover', '?topic=tech&door=join&error=x', 'login', 'github')
    expect(back).toBe('/discover?topic=tech&door=login&via=github')
    const query = `${new URL(back, 'https://tela.test').search}&error=access_denied&error_description=no`
    expect(withoutDoor('/discover', query)).toBe('/discover?topic=tech')
    expect(withoutDoor('/', '?door=join&via=google&error=access_denied')).toBe('/')
  })
  test("ingest errors become the page's own", () => {
    expect(addError('not_a_feed')).toBe('fetch_failed')
    expect(addError('rate_limited')).toBe('rate_limited')
    expect(claimError('not_a_feed')).toBe('no_feed')
    expect(claimError('unreachable')).toBe('fetch_failed')
  })
})

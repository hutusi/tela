import { describe, expect, test } from 'bun:test'
import { discoverApiPath, discoverHref, parseDiscoverParams } from '../src/lib/discover-href'
import { canonicalReadingHref, parseReadingParams, readingHref } from '../src/lib/href'
import { addError } from '../src/lib/opml'
import { claimError } from '../src/pages/claim'
import { safeNext } from '../src/pages/login'
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
  test('are Discover, a blog by id and a profile by handle, and nothing else', () => {
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
    for (const path of ['/s/12/x', '/s/abc', '/@', '/@a/b', '/reading'])
      expect(route(path)).toBeNull()
    expect(handleFrom('/%40someone')).toBe('someone')
  })
})

describe('answers the pages turn into messages', () => {
  test('sign-in returns only to this site', () => {
    expect(safeNext('/s/1')).toBe('/s/1')
    for (const next of [null, 'https://evil.example', '//evil.example', '/\\evil.example']) {
      expect(safeNext(next)).toBe('/reading')
    }
  })
  test("ingest errors become the page's own", () => {
    expect(addError('not_a_feed')).toBe('fetch_failed')
    expect(addError('rate_limited')).toBe('rate_limited')
    expect(claimError('not_a_feed')).toBe('no_feed')
    expect(claimError('unreachable')).toBe('fetch_failed')
  })
})

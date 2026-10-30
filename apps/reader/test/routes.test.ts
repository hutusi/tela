import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { errorKey } from '../src/components/front-door'
import { detectLocale } from '../src/i18n'
import { blogsApiPath, blogsHref, parseBlogsParams, tabOf } from '../src/lib/discover-href'
import { feedRoute } from '../src/lib/feed-href'
import { canonicalReadingHref, listsFilter, parseReadingParams, readingHref } from '../src/lib/href'
import { addError } from '../src/lib/opml'
import { safeDecode } from '../src/lib/safe-decode'
import {
  codeError,
  doorRoutes,
  errorReturn,
  joinError,
  loginPath,
  mailLink,
  passwordError,
  providerError,
  safeNext,
  startError,
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
      folderId: null,
      articleId: null,
      mode: null,
    })
  })

  test('name a folder (ADR 0048) instead of a blog or a filter, never beside them', () => {
    const folder = 'f-0b6c2a1e'
    expect(readingHref({ folderId: folder, articleId: 7, mode: 'orig' })).toBe(
      `/reading?folder=${folder}&article=7&mode=orig`,
    )
    // A folder link drops the blog and the filter it was given beside.
    expect(readingHref({ filter: 'today', feedId: 3, folderId: folder })).toBe(
      `/reading?folder=${folder}`,
    )
    // And a URL that names both reads as the folder.
    expect(parseReadingParams(new URLSearchParams(`filter=liked&feed=3&folder=${folder}`))).toEqual(
      { filter: 'all', feedId: null, folderId: folder, articleId: null, mode: null },
    )
    // Closing an article, or stepping to the next, keeps the folder.
    expect(
      canonicalReadingHref(`?folder=${folder}&article=7&mode=trans`, { articleId: 8, mode: null }),
    ).toBe(`/reading?folder=${folder}&article=8`)
    // An id no device would mint is no folder: the list of everything.
    for (const raw of ['', 'short', 'has space', '<script>', 'x'.repeat(65)]) {
      expect(parseReadingParams(new URLSearchParams({ folder: raw })).folderId).toBeNull()
    }
  })

  test('say which filter is listed only when no blog or folder is', () => {
    const at = (search: string) => parseReadingParams(new URLSearchParams(search))
    expect(listsFilter(at(''), 'all')).toBe(true)
    expect(listsFilter(at('filter=today'), 'today')).toBe(true)
    expect(listsFilter(at('feed=3'), 'all')).toBe(false)
    expect(listsFilter(at('folder=f-0b6c2a1e'), 'all')).toBe(false)
  })
})

describe("Discover's Blogs URLs", () => {
  test('keep a known topic and a language tag, in one order', () => {
    const params = parseBlogsParams(new URLSearchParams('lang=ja&topic=tech&utm=x'))
    expect(params).toEqual({ topic: 'tech', lang: 'ja', page: 1 })
    expect(blogsHref(params)).toBe('/discover/blogs?topic=tech&lang=ja')
    // The page moved; its endpoint did not (ADR 0044).
    expect(blogsApiPath(params)).toBe('/api/v1/public/discover?topic=tech&lang=ja')
    expect(parseBlogsParams(new URLSearchParams('topic=nope&lang=<x>'))).toEqual({
      topic: null,
      lang: null,
      page: 1,
    })
  })

  test('carry a page past the first, and read anything else as the first', () => {
    const params = parseBlogsParams(new URLSearchParams('topic=food&page=2'))
    expect(params).toEqual({ topic: 'food', lang: null, page: 2 })
    expect(blogsApiPath(params)).toBe('/api/v1/public/discover?topic=food&page=2')
    // A topic or a language chosen from page 2 starts again at page 1.
    expect(blogsHref({ topic: 'cities', lang: params.lang })).toBe('/discover/blogs?topic=cities')
    for (const page of ['1', '0', '-3', '2.5', 'x', '1001']) {
      expect(parseBlogsParams(new URLSearchParams(`page=${page}`)).page).toBe(1)
    }
  })
})

describe('public pages at the edge', () => {
  test("are Discover's tabs, a blog by id, a profile by handle and the info pages, and nothing else", () => {
    const route = (path: string) => publicRoute(new URL(path, 'https://tela.test'))
    // Each tab always exists: a tela-api without its endpoint yet is the plain shell, not a 404.
    expect(route('/discover?utm_source=x')).toEqual({
      kind: 'week',
      api: '/api/v1/public/discover/week',
      alwaysExists: true,
    })
    expect(route('/discover/blogs?topic=tech')).toMatchObject({
      kind: 'blogs',
      api: '/api/v1/public/discover?topic=tech',
      alwaysExists: true,
    })
    expect(route('/discover/readers?x=1')).toEqual({
      kind: 'readers',
      api: '/api/v1/public/discover/readers',
      alwaysExists: true,
    })
    // Articles' two sorts are one endpoint and two pages, and so is a page reached by cursor.
    expect(route('/discover/articles?topic=tech')).toMatchObject({
      kind: 'articles',
      api: '/api/v1/public/discover/articles?topic=tech',
      key: '/discover/articles?topic=tech',
      alwaysExists: true,
    })
    expect(route('/discover/articles?sort=new&topic=tech&utm_source=x')).toMatchObject({
      api: '/api/v1/public/discover/articles?topic=tech',
      key: '/discover/articles?topic=tech&sort=new',
    })
    expect(route('/discover/articles?sort=new&cursor=1700000000000:42')).toMatchObject({
      api: '/api/v1/public/discover/articles?cursor=1700000000000%3A42',
      key: '/discover/articles?sort=new&cursor=1700000000000%3A42',
    })
    // An address from before the tabs moved, whole query and all; nothing else on it did.
    expect(route('/discover?topic=tech&door=login&via=github')).toEqual({
      kind: 'redirect',
      api: null,
      redirect: '/discover/blogs?topic=tech&door=login&via=github',
    })
    expect(route('/discover?page=2')).toMatchObject({ redirect: '/discover/blogs?page=2' })
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
    // So does For writers (ADR 0061), whatever is in its query.
    expect(route('/writers?utm_source=x')).toEqual({ kind: 'writers', api: null, key: '/writers' })
    // And How Tela reads your blog (ADR 0070).
    expect(route('/bot?utm_source=x')).toEqual({ kind: 'bot', api: null, key: '/bot' })
    for (const path of [
      '/discover/',
      '/discover/week',
      '/discover/blogs/x',
      '/s/12/x',
      '/s/abc',
      '/@',
      '/@a/b',
      '/reading',
      '/about/',
      '/about/x',
      '/About',
      '/info/about',
      '/writers/',
      '/writers/x',
      '/bot/',
      '/bot/x',
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
    // SPA-only: a code in `/join?code=` must never reach a cached page, or Workers Logs; nor an
    // app's authorization request in `/connect?…` (ADR 0064).
    for (const path of [
      '/join',
      '/join?code=ABCD',
      '/__tela/shell',
      '/admin/feeds',
      '/connect?client_id=tela_app_x&state=s&code_challenge=c',
    ])
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
    const pages = [
      '/',
      '/?titles=translated',
      '/discover',
      '/discover?topic=tech',
      '/discover/articles?sort=new',
      '/discover/blogs?topic=tech',
      '/discover/readers',
      '/discover/blogrolls',
      '/discover/blogrolls?cursor=1700000000000:abcdefABCDEF',
      '/s/12',
      '/l/abcdefABCDEF',
      '/@reader_1',
      '/@reader_1?tab=blogrolls',
      '/about',
      '/privacy',
      '/terms',
      '/writers',
      '/bot',
    ]
    for (const page of pages) {
      const url = new URL(page, 'https://tela.test')
      expect(publicRoute(url)).not.toBeNull()
      expect(runsFirst(url.pathname)).toBe(true)
    }
    // The shell the service worker keeps is fetched from a path the Worker never runs for, and
    // neither are the SPA's own pages: a code in `/join?code=` must never reach a cached page, or
    // Workers Logs (ADR 0035).
    // The admin console is the SPA's too: never rendered or cached at the edge (ADR 0039).
    // So is an app's consent page, whose query is the authorization request (ADR 0064).
    for (const path of ['/__tela/shell', '/join', '/admin', '/admin/feeds', '/connect'])
      expect(runsFirst(path)).toBe(false)
    expect(patterns).not.toContain('/*')
    expect(patterns.filter((p) => p.startsWith('/discover'))).toEqual([
      '/discover',
      '/discover/articles',
      '/discover/blogs',
      '/discover/blogrolls',
      '/discover/readers',
      // Discover's feeds (ADR 0062), by name too.
      '/discover.opml',
      '/discover/articles.rss',
    ])
    // So do Tela's own feeds: the asset router would answer each with the app's HTML, 200.
    for (const path of [
      '/l/abcdefABCDEF.rss',
      '/l/abcdefABCDEF.opml',
      '/discover.opml',
      '/discover/articles.rss',
    ]) {
      expect(feedRoute(new URL(path, 'https://tela.test'))).not.toBeNull()
      expect(runsFirst(path)).toBe(true)
    }
  })
})

describe('blogrolls at the edge (ADR 0050)', () => {
  const route = (path: string) => publicRoute(new URL(path, 'https://tela.test'))

  test("a blogroll's page is `/l/` and its id, and nothing else under `/l/` is a page", () => {
    expect(route('/l/abcdefABCDEF?utm_source=x')).toEqual({
      kind: 'blogroll',
      id: 'abcdefABCDEF',
      api: '/api/v1/public/blogrolls/abcdefABCDEF',
    })
    expect(route('/l/0123456789ab')).toMatchObject({ id: '0123456789ab' })
    for (const path of [
      '/l',
      '/l/',
      '/l/short',
      '/l/abcdefABCDEFG',
      '/l/x/y',
      '/l/abcdefABCDEF/',
      '/l/abcdefABCDEF/x',
      '/l/abcdefABCDE!',
      '/l/abcdefABCD%20',
      '/l/%',
      '/L/abcdefABCDEF',
    ])
      expect(route(path)).toBeNull()
  })

  test("Discover's Blogrolls always exists, and a page reached by cursor is a page of its own", () => {
    expect(route('/discover/blogrolls?utm_source=x')).toEqual({
      kind: 'blogrolls',
      cursor: null,
      api: '/api/v1/public/discover/blogrolls',
      key: '/discover/blogrolls',
      alwaysExists: true,
    })
    expect(route('/discover/blogrolls?cursor=1700000000000:abcdefABCDEF')).toMatchObject({
      cursor: '1700000000000:abcdefABCDEF',
      api: '/api/v1/public/discover/blogrolls?cursor=1700000000000%3AabcdefABCDEF',
      key: '/discover/blogrolls?cursor=1700000000000%3AabcdefABCDEF',
    })
    // A cursor tela-api never wrote is the first page, under the first page's key.
    for (const cursor of ['x', '1700:short', '-1:abcdefABCDEF', '1700000000000:abcdefABCDE!'])
      expect(route(`/discover/blogrolls?cursor=${encodeURIComponent(cursor)}`)).toMatchObject({
        cursor: null,
        key: '/discover/blogrolls',
      })
    expect(route('/discover/blogrolls/')).toBeNull()
    expect(route('/discover/blogrolls/x')).toBeNull()
    expect(tabOf('/discover/blogrolls')).toBe('blogrolls')
    expect(tabOf('/discover/blogrolls/')).toBeNull()
  })

  test("a profile's Blogrolls tab is a page of its own, cached apart", () => {
    expect(route('/@reader_1?tab=blogrolls')).toMatchObject({
      kind: 'profile',
      tab: 'blogrolls',
      api: '/api/v1/public/profiles/reader_1',
      key: '/api/v1/public/profiles/reader_1?tab=blogrolls',
    })
  })
})

describe('answers the pages turn into messages', () => {
  test('sign-in returns only to this site', () => {
    expect(safeNext('/s/1')).toBe('/s/1')
    expect(safeNext('/reading?article=7#top')).toBe('/reading?article=7#top')
    // A browser drops a tab or a newline and reads a backslash as a slash: each is another site.
    const elsewhere = [
      null,
      'https://evil.example',
      '//evil.example',
      '/\\evil.example',
      '/\t/evil.example',
      '/\n/evil.example',
      '/\r//evil.example',
    ]
    for (const next of elsewhere) expect(safeNext(next)).toBe('/reading')
  })
  test('the sheet sends a member it finds already in where a member goes, not to Discover', () => {
    // Signed in by the sheet: a joiner is a newcomer, a log-in goes where it was asked to.
    expect(doorRoutes('join', null, null)).toEqual({
      next: '/discover',
      newcomer: '/discover',
      settledNext: '/reading',
    })
    expect(doorRoutes('login', '/settings', null)).toEqual({
      next: '/settings',
      newcomer: '/discover',
      settledNext: '/settings',
    })
    expect(doorRoutes('login', '//evil.example', null).settledNext).toBe('/reading')
    // A card is for its claim, whoever opens it.
    for (const mode of ['join', 'login'] as const) {
      expect(doorRoutes(mode, null, '/claim?url=x')).toEqual({
        next: '/claim?url=x',
        newcomer: '/claim?url=x',
        settledNext: '/claim?url=x',
      })
    }
  })
  test('the consent page keeps whoever the sheet lets in, a joiner too (ADR 0064)', () => {
    const here = { pathname: '/connect', search: '?client_id=tela_app_x&state=s%2F1' }
    const stay = '/connect?client_id=tela_app_x&state=s%2F1'
    for (const mode of ['join', 'login'] as const) {
      expect(doorRoutes(mode, '/settings', null, here)).toEqual({
        next: stay,
        newcomer: stay,
        settledNext: stay,
      })
    }
    // Any other page keeps its own rules.
    expect(doorRoutes('join', null, null, { pathname: '/discover', search: '?x=1' })).toEqual({
      next: '/discover',
      newcomer: '/discover',
      settledNext: '/reading',
    })
  })
  test("a mailed link's code is read, and nothing but where to go next stays in the address", () => {
    const link = (query: string) => new URLSearchParams(query)
    expect(mailLink(link('email=a%40x.test&otp=123456&next=%2Fsettings'))).toEqual({
      email: 'a@x.test',
      otp: '123456',
      reset: false,
      join: false,
    })
    expect(mailLink(link('reset=1&email=a%40x.test&otp=123456'))).toEqual({
      email: 'a@x.test',
      otp: '123456',
      reset: true,
      join: false,
    })
    // A first sign-in's link asks for a password (ADR 0043); a reset is never a join.
    expect(mailLink(link('email=a%40x.test&otp=123456&join=1'))).toMatchObject({
      reset: false,
      join: true,
    })
    expect(mailLink(link('reset=1&join=1&email=a%40x.test&otp=123456'))).toMatchObject({
      reset: true,
      join: false,
    })
    expect(loginPath(link('email=a%40x.test&otp=123456&join=1'))).toBe('/login')
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
    // Sign-up is open, and today's places are taken (ADR 0056).
    expect(codeError(403, 'SIGNUPS_PAUSED')).toBe('signups_paused')
  })
  test('an account suspended or deleted is told so, never that the code or password was wrong', () => {
    expect(codeError(403, 'ACCOUNT_SUSPENDED')).toBe('account_suspended')
    expect(codeError(403, 'ACCOUNT_CLOSED')).toBe('account_closed')
    expect(passwordError(403, 'ACCOUNT_SUSPENDED')).toBe('account_suspended')
    expect(passwordError(403, 'ACCOUNT_CLOSED')).toBe('account_closed')
    // Otherwise one answer for an unknown address, an account without a password and a wrong one.
    expect(passwordError(401, 'INVALID_EMAIL_OR_PASSWORD')).toBe('bad_password')
    expect(passwordError(400, undefined)).toBe('bad_password')
    expect(passwordError(429, 'ACCOUNT_SUSPENDED')).toBe('rate_limited')
    expect(passwordError(503, undefined)).toBe('failed')
    // A provider's return names them in lowercase, as every refusal there.
    expect(providerError('account_suspended')).toBe('account_suspended')
    expect(providerError('account_closed')).toBe('account_closed')
    expect(providerError('ACCOUNT_SUSPENDED')).toBe('account_suspended')
  })
  test("a join's answers", () => {
    expect(joinError(400, 'invalid_code')).toBe('invalid_code')
    expect(joinError(400, 'invalid_email')).toBe('invalid_email')
    expect(joinError(409, 'code_used')).toBe('code_used')
    expect(joinError(429, 'rate_limited')).toBe('rate_limited')
    expect(joinError(500, undefined)).toBe('send_failed')
    // While sign-up is open (ADR 0056): a day whose places are taken, and a join that sent no code
    // to a Tela that went back to invitations meanwhile, which a code it never sent cannot answer.
    expect(joinError(403, 'signups_paused')).toBe('signups_paused')
    expect(joinError(400, 'invalid_code', false)).toBe('invite_only')
    expect(joinError(400, 'invalid_code', true)).toBe('invalid_code')
  })
  test('while sign-up is open, a code that is no code is to put right or leave out', () => {
    expect(errorKey('invalid_code', true)).toBe('invalid_code_optional')
    expect(errorKey('invalid_code', false)).toBe('invalid_code')
    expect(errorKey('signups_paused', true)).toBe('signups_paused')
  })
  test("a provider's refusal, in either case, and any code nobody listed", () => {
    expect(providerError('invite_required')).toBe('not_invited')
    expect(providerError('INVITE_REQUIRED')).toBe('not_invited')
    expect(providerError('invite_unavailable')).toBe('invite_used')
    expect(providerError('signups_paused')).toBe('signups_paused')
    expect(providerError('account_not_linked')).toBe('provider_unlinked')
    expect(providerError('email_not_verified')).toBe('provider_unlinked')
    expect(providerError('email_not_found')).toBe('provider_no_email')
    expect(providerError('access_denied')).toBe('provider_cancelled')
    expect(providerError('state_mismatch')).toBe('provider_expired')
    expect(providerError('unable_to_create_user')).toBe('provider_failed')
    expect(providerError('something_new')).toBe('provider_failed')
  })
  test("a provider's start refused for its invite code says so, not that the provider failed", () => {
    expect(startError(400, 'INVALID_CODE')).toBe('invalid_code')
    expect(startError(409, 'INVITE_USED')).toBe('code_used')
    expect(startError(429, 'TOO_MANY_REQUESTS')).toBe('rate_limited')
    expect(startError(400, 'VALIDATION_ERROR')).toBe('provider_failed')
    expect(startError(500, undefined)).toBe('provider_failed')
    // At the return, better-auth's own invalid_code is a failed token exchange: the provider's.
    expect(providerError('invalid_code')).toBe('provider_failed')
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
    expect(addError('feed_too_large')).toBe('feed_too_large')
    expect(claimError('feed_too_large')).toBe('feed_too_large')
  })
})

describe('what a visitor types that does not decode', () => {
  test('is null, never a throw', () => {
    expect(safeDecode('%40someone')).toBe('@someone')
    expect(safeDecode('%E4%B8%AD')).toBe('中')
    expect(safeDecode('')).toBe('')
    // A lone `%`, one without two hex digits, and escapes that are not UTF-8.
    for (const bad of ['%', '%zz', 'a%2', '%E4', '%C0%AF']) expect(safeDecode(bad)).toBeNull()
  })

  test('is no profile, at the edge or in the app', () => {
    const route = (path: string) => publicRoute(new URL(path, 'https://tela.test'))
    for (const path of ['/@%', '/%', '/@a%zz', '/%40%E4']) {
      expect(handleFrom(path)).toBeNull()
      expect(route(path)).toBeNull()
    }
  })

  test('is no choice of language: the browser decides', () => {
    expect(detectLocale('tela_locale=%', ['zh-CN'])).toBe('zh-Hans')
    expect(detectLocale('a=1; tela_locale=%E4; b=2', ['en-US'])).toBe('en')
    expect(detectLocale('a=1; tela_locale=zh-Hans', ['en-US'])).toBe('zh-Hans')
  })
})

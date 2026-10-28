/**
 * Reporting from a public page (ADR 0059): a visitor's mail to the contact address, built from the
 * page's own address so the edge's cached copy holds the same link for everyone; a member's sheet,
 * which sends the report and words what came back; and where the link shows, and where it does
 * not (your own profile, blogroll or blog). No effect runs in a server render, so nothing opens
 * here; what the sheet sends is `sendReport`'s, tested against the answers tela-api gives.
 */
import { afterAll, afterEach, describe, expect, test } from 'bun:test'
import { REPORT_ADDRESS } from '@tela/shared'
import type { ReactNode } from 'react'
import { renderToString } from 'react-dom/server'
import { MemoryRouter } from 'react-router'
import { I18n } from '../src/i18n'
import {
  detailsLength,
  PUBLIC_ORIGIN,
  reportedAddress,
  reportMailto,
  sendReport,
} from '../src/lib/reporting'
import { publicRoute, renderPublicPage } from '../src/ssr'
import { bindApi } from '../src/store/api'
import { BlogrollView } from '../src/views/blogroll'
import { ProfileView } from '../src/views/profile'
import { SiteView } from '../src/views/site'
import type { BlogrollData, MemberControls, ProfileData, SiteData } from '../src/views/types'

const ANNA = 'u-anna-000001'

const article = (id: number) => ({
  id,
  feedId: 1,
  url: `https://anna.example/${id}`,
  title: `Post ${id}`,
  author: null,
  publishedAt: 0,
  fetchedAt: 0,
  sortAt: 0,
  sourceLang: 'en',
  excerpt: null,
  readingMinutes: 3,
  likeCount: 0,
  recommendCount: 1,
  contentKey: null,
  seq: 1,
})

const PROFILE: ProfileData = {
  profile: {
    id: ANNA,
    handle: 'anna',
    displayName: 'Anna',
    bio: null,
    avatar: null,
    memberSince: 0,
  },
  counts: { following: 0, followers: 0, recommendations: 1, liked: null, subscriptions: null },
  blogs: [],
  recommendations: [
    {
      note: 'Read this one',
      createdAt: 0,
      siteId: 1,
      siteTitle: 'Anna writes',
      homeUrl: 'https://anna.example',
      listed: true,
      article: article(7) as never,
    },
  ],
  subscriptions: null,
  liked: null,
  blogrolls: [],
}

const SITE: SiteData = {
  site: {
    id: 12,
    title: 'Blog twelve',
    homeUrl: 'https://twelve.example',
    description: null,
    faviconKey: null,
    primaryLang: 'en',
    readerCount: null,
    claimedBy: null,
    claimant: null,
    postsLast30d: 0,
  },
  feeds: [{ id: 1, feedUrl: 'https://twelve.example/feed', title: null }],
  posts: [],
  topics: [],
  notes: [
    {
      note: 'A fine post',
      createdAt: 0,
      person: { id: ANNA, handle: 'anna', displayName: 'Anna' },
      article: article(7) as never,
    },
    // From a tela-api before ADR 0059, which named no account: nothing to report it by.
    {
      note: 'Older note',
      createdAt: 0,
      person: { handle: 'bea', displayName: 'Bea' },
      article: article(8) as never,
    },
  ],
}

const BLOGROLL: BlogrollData = {
  blogroll: { id: 'annasRoll001', name: 'Anna reads', description: '', updatedAt: 0 },
  owner: { id: ANNA, handle: 'anna', displayName: 'Anna', avatar: null },
  blogs: [],
}

function member(userId = 'u-reader-00001', handle = 'reader'): MemberControls {
  return {
    isSubscribed: () => false,
    toggle() {},
    readHref: () => '/reading',
    hold() {},
    handle,
    userId,
    isFollowing: () => false,
    setFollowing() {},
  }
}

const wrap = (node: ReactNode) =>
  renderToString(
    <I18n locale="en">
      <MemoryRouter>{node}</MemoryRouter>
    </I18n>,
  ).replaceAll('<!-- -->', '')

const reading = { lang: 'en', never: [] }
const links = (html: string) =>
  [...html.matchAll(/<(a|button)[^>]*data-testid="report-link"[^>]*>/g)].map((m) => m[0])
const kinds = (html: string) =>
  links(html).map(
    (tag) => `${tag.startsWith('<a') ? 'mail' : 'sheet'}:${/data-report="(\w+)"/.exec(tag)?.[1]}`,
  )
const mailOf = (html: string, kind: string) => {
  const tag = links(html).find((l) => l.includes(`data-report="${kind}"`)) ?? ''
  return (/href="([^"]*)"/.exec(tag)?.[1] ?? '').replaceAll('&amp;', '&')
}

describe("a visitor's report", () => {
  test('is a mail to the contact address, its subject saying what, its body the page', () => {
    expect(reportMailto('Report: a profile on Tela', '/@anna')).toBe(
      `mailto:${REPORT_ADDRESS}?subject=Report%3A%20a%20profile%20on%20Tela&body=https%3A%2F%2Ftelaread.com%2F%40anna`,
    )
    const html = wrap(
      <ProfileView data={PROFILE} tab="recommendations" reading={reading} locale="en" now={0} />,
    )
    expect(kinds(html)).toEqual(['mail:profile', 'mail:recommendation'])
    expect(mailOf(html, 'profile')).toBe(reportMailto('Report: a profile on Tela', '/@anna'))
    expect(html).toContain('aria-label="Report this profile by email"')
  })

  test('names the page by its own address, whatever the browser asked for', () => {
    const route = publicRoute(new URL('https://telaread.com/@anna?utm_source=x&tab=blogrolls'))
    if (!route) throw new Error('no route')
    const page = renderPublicPage({
      route,
      url: new URL('https://telaread.com/@anna?utm_source=x'),
      data: PROFILE,
      locale: 'en',
      now: 0,
      template:
        '<html lang="en"><head><title>Tela</title></head><body><div id="root"></div></body></html>',
    })
    // The edge's copy is a guest's: the mail, never a member's sheet.
    expect(kinds(page)).toEqual(['mail:profile', 'mail:recommendation'])
    expect(mailOf(page, 'profile')).toContain(
      `body=${encodeURIComponent(`${PUBLIC_ORIGIN}/@anna`)}`,
    )
    expect(page).not.toContain('utm_source')
    expect(page).not.toContain('aria-haspopup="dialog"')
  })
})

describe('where Report shows', () => {
  test("for a member: a sheet, on someone else's profile and notes, never their own", () => {
    const theirs = wrap(
      <ProfileView
        data={PROFILE}
        tab="recommendations"
        member={member()}
        reading={reading}
        locale="en"
        now={0}
      />,
    )
    expect(kinds(theirs)).toEqual(['sheet:profile', 'sheet:recommendation'])
    expect(theirs).toContain('aria-label="Report this note"')
    const mine = wrap(
      <ProfileView
        data={PROFILE}
        tab="recommendations"
        member={member(ANNA, 'anna')}
        reading={reading}
        locale="en"
        now={0}
      />,
    )
    expect(kinds(mine)).toEqual([])
  })

  test('a profile from a tela-api with no account id has nothing to report it by', () => {
    const old = { ...PROFILE, profile: { ...PROFILE.profile, id: '' } }
    expect(
      kinds(
        wrap(
          <ProfileView data={old} tab="recommendations" reading={reading} locale="en" now={0} />,
        ),
      ),
    ).toEqual([])
  })

  test("a blog's page: the blog, and each note whose author it names", () => {
    const guest = wrap(<SiteView data={SITE} reading={reading} locale="en" now={0} />)
    expect(kinds(guest)).toEqual(['mail:site', 'mail:recommendation'])
    expect(mailOf(guest, 'site')).toBe(reportMailto('Report: a blog on Tela', '/s/12'))
    const signed = wrap(
      <SiteView data={SITE} member={member()} reading={reading} locale="en" now={0} />,
    )
    expect(kinds(signed)).toEqual(['sheet:site', 'sheet:recommendation'])
    // The blog's own writer, and their own note, have nothing to report.
    const owner = wrap(
      <SiteView
        data={{
          ...SITE,
          site: {
            ...SITE.site,
            claimedBy: 'anna',
            claimant: { handle: 'anna', displayName: 'Anna', bio: null },
          },
        }}
        member={member(ANNA, 'anna')}
        reading={reading}
        locale="en"
        now={0}
      />,
    )
    expect(kinds(owner)).toEqual([])
  })

  test("a blogroll's page, unless it is the reader's own", () => {
    expect(kinds(wrap(<BlogrollView data={BLOGROLL} locale="en" now={0} />))).toEqual([
      'mail:blogroll',
    ])
    expect(
      kinds(wrap(<BlogrollView data={BLOGROLL} member={member()} locale="en" now={0} />)),
    ).toEqual(['sheet:blogroll'])
    expect(
      kinds(wrap(<BlogrollView data={BLOGROLL} member={member(ANNA)} locale="en" now={0} />)),
    ).toEqual([])
  })
})

describe("a member's report", () => {
  const saved = globalThis.fetch
  afterAll(() => {
    globalThis.fetch = saved
  })
  afterEach(() => {
    bindApi({ member: () => null, accountChanged() {}, upgrade() {} })
  })

  function answer(status: number) {
    const calls: { path: string; body: unknown; member: string | null }[] = []
    globalThis.fetch = (async (input: string, init?: RequestInit) => {
      calls.push({
        path: String(input),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
        member: new Headers(init?.headers).get('x-tela-member'),
      })
      return Response.json(status === 200 ? { ok: true } : { error: 'x' }, { status })
    }) as typeof fetch
    bindApi({ member: () => 'u-reader-00001', accountChanged() {}, upgrade() {} })
    return calls
  }

  const input = {
    subject: { kind: 'profile' as const, key: ANNA },
    reason: 'spam' as const,
    details: '  Ads everywhere.  ',
    path: '/@anna',
    url: 'https://telaread.com/@anna',
  }

  test('sends what was chosen, trimmed, naming the member', async () => {
    const calls = answer(200)
    expect(await sendReport(input)).toBe('sent')
    expect(calls).toEqual([
      {
        path: '/api/v1/reports',
        member: 'u-reader-00001',
        body: {
          targetKind: 'profile',
          targetKey: ANNA,
          reason: 'spam',
          details: 'Ads everywhere.',
          url: 'https://telaread.com/@anna',
        },
      },
    ])
  })

  test('leaves out empty words, and an address too long to keep', async () => {
    const calls = answer(200)
    await sendReport({
      ...input,
      details: '   ',
      url: `https://telaread.com/@anna?${'x'.repeat(1000)}`,
    })
    expect(calls[0]?.body).toEqual({
      targetKind: 'profile',
      targetKey: ANNA,
      reason: 'spam',
      url: `${PUBLIC_ORIGIN}/@anna`,
    })
  })

  test('says why it did not go', async () => {
    answer(429)
    expect(await sendReport(input)).toBe('rate_limited')
    answer(404)
    expect(await sendReport(input)).toBe('not_found')
    answer(500)
    expect(await sendReport(input)).toBe('failed')
    globalThis.fetch = (async () => {
      throw new TypeError('offline')
    }) as unknown as typeof fetch
    expect(await sendReport(input)).toBe('failed')
  })

  test('sends the page as the browser has it, or without a query that holds a request', () => {
    const at = {
      href: 'https://telaread.com/connect?client_id=tela_app_x&state=SECRET#top',
      origin: 'https://telaread.com',
      pathname: '/connect',
    }
    expect(reportedAddress(at, false)).toBe(at.href)
    // The consent page's query is the app's request, its state among it (ADR 0067).
    expect(reportedAddress(at, true)).toBe('https://telaread.com/connect')
  })

  test('counts its words as tela-api does, in code points', () => {
    expect(detailsLength('🙂🙂')).toBe(2)
    expect(detailsLength('  a  ')).toBe(1)
  })
})

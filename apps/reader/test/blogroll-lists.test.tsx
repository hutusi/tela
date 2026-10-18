/**
 * Blogrolls in lists (ADR 0050): a profile's Blogrolls tab as its owner sees it (their device's
 * blogrolls, private ones too, and New blogroll), Discover's tab with the reasons a member's device
 * puts on it, and the pages "More" brings. The visitor's pages, as the edge renders them, are in
 * `edge.test.ts`.
 */
import { describe, expect, test } from 'bun:test'
import type { ReactNode } from 'react'
import { renderToString } from 'react-dom/server'
import { MemoryRouter } from 'react-router'
import { I18n } from '../src/i18n'
import {
  blogrollsList,
  fetchingBlogrolls,
  fetchMoreBlogrolls,
  forgetDiscoverBlogrolls,
  heldBlogrolls,
  resetBlogrollsPages,
} from '../src/lib/blogroll-pages'
import { DiscoverBlogrollsView } from '../src/views/discover-blogrolls'
import { type OwnBlogrolls, ProfileView, profileTab } from '../src/views/profile'
import type { BlogrollCard, BlogrollsData, Person, ProfileData } from '../src/views/types'

const render = (node: ReactNode) =>
  renderToString(
    <MemoryRouter>
      <I18n locale="en">{node}</I18n>
    </MemoryRouter>,
  )

const ann: Person = { id: 'id-ann-0000', handle: 'ann', displayName: 'Ann K', avatar: null }
const bo: Person = { id: 'id-bo-00000', handle: 'bo', displayName: null, avatar: null }

const card = (id: string, name: string, owner: Person = ann): BlogrollCard => ({
  id,
  name,
  description: '',
  owner,
  blogCount: 1,
  blogs: [{ feedId: 1, siteId: 1, name: 'Calle Toledo', homeUrl: 'https://calle.example' }],
  publicSince: 1,
  updatedAt: 1,
})

const profile = (blogrolls: BlogrollCard[]): ProfileData => ({
  profile: { id: ann.id, handle: 'ann', displayName: 'Ann K', bio: null, memberSince: 0 },
  counts: { following: 0, followers: 0, recommendations: 0, liked: null, subscriptions: null },
  blogs: [],
  recommendations: [],
  subscriptions: null,
  liked: null,
  blogrolls,
})

const own = (cards: OwnBlogrolls['cards']): OwnBlogrolls => ({ cards, onNew: () => {} })

const count = (html: string, needle: string) => html.split(needle).length - 1

describe("a profile's Blogrolls tab", () => {
  const reading = { lang: 'en', never: [] }
  const view = (data: ProfileData, tab: 'blogrolls' | 'recommendations', mine?: OwnBlogrolls) =>
    render(<ProfileView data={data} tab={tab} reading={reading} locale="en" now={0} own={mine} />)

  test('is shown to others once there is a public blogroll, and always to its owner', () => {
    const none = profile([])
    expect(profileTab('blogrolls', none)).toBe('recommendations')
    expect(profileTab('blogrolls', none, true)).toBe('blogrolls')
    expect(profileTab('blogrolls', profile([card('abcdefABCDEF', 'Cities')]))).toBe('blogrolls')
    expect(view(none, 'recommendations')).not.toContain('data-testid="profile-tab-blogrolls"')
    expect(view(none, 'recommendations', own([]))).toContain('data-testid="profile-tab-blogrolls"')
  })

  test("its owner's lists every one of theirs, private ones marked, with New blogroll", () => {
    // The page's copy knows one public blogroll; the device holds that one and a private one.
    const html = view(
      profile([card('abcdefABCDEF', 'Cities')]),
      'blogrolls',
      own([
        { card: card('0123456789ab', 'Drafts'), isPublic: false },
        { card: card('abcdefABCDEF', 'Cities'), isPublic: true },
      ]),
    )
    expect(html).toMatch(/data-testid="profile-tab-blogrolls"[^>]*>Blogrolls<span[^>]*>2<\/span>/)
    const cards = [...html.matchAll(/data-testid="blogroll-card" data-blogroll-id="(\w+)"/g)]
    expect(cards.map((m) => m[1])).toEqual(['0123456789ab', 'abcdefABCDEF'])
    expect(count(html, 'data-testid="blogroll-private"')).toBe(1)
    expect(html.split('Cities')[0]).toContain('Private')
    expect(html).toContain('Others can subscribe to every blog in a blogroll at once.')
    expect(count(html, 'data-testid="new-blogroll"')).toBe(1)
  })

  test('its owner with none is offered one, once', () => {
    const html = view(profile([]), 'blogrolls', own([]))
    expect(html).toContain('data-testid="profile-blogrolls"')
    expect(html).toContain('No blogrolls yet. Make one to share the blogs you read.')
    expect(count(html, 'data-testid="new-blogroll"')).toBe(1)
    expect(html).not.toContain('data-testid="blogroll-card"')
    expect(html).toContain('New blogroll')
  })
})

describe("Discover's Blogrolls", () => {
  test("says why the member is shown one, from their device, and nothing for a visitor's", () => {
    const cards = [card('abcdefABCDEF', 'Cities'), card('0123456789ab', 'Mine', bo)]
    const reasons = render(
      <DiscoverBlogrollsView
        cards={cards}
        next={null}
        reasonOf={(c) => (c.owner.id === bo.id ? 'yours' : 'follows')}
      />,
    )
    expect(reasons).toContain('Someone you follow')
    expect(reasons).toContain('Yours')
    // An owner with no name is named by their handle.
    expect(reasons).toContain('@bo')
    // The member's own picture is on the accent, as everywhere.
    expect(count(reasons, 'bg-accent')).toBe(1)
    expect(reasons).not.toContain('data-testid="blogrolls-more"')

    const visitor = render(<DiscoverBlogrollsView cards={cards} next={null} />)
    expect(visitor).not.toContain('data-testid="blogroll-reason"')
  })

  test('waits, says when there are none, and links to the next page', () => {
    expect(render(<DiscoverBlogrollsView cards={null} next={null} />)).toContain('aria-busy="true"')
    expect(render(<DiscoverBlogrollsView cards={[]} next={null} />)).toContain(
      'data-testid="blogrolls-empty"',
    )
    const more = render(
      <DiscoverBlogrollsView cards={[card('abcdefABCDEF', 'Cities')]} next="5:abcdefABCDEF" />,
    )
    expect(more).toContain('href="/discover/blogrolls?cursor=5%3AabcdefABCDEF"')
    expect(more).toContain('More blogrolls')
  })
})

describe("Blogrolls' pages after the first", () => {
  const page = (next: string | null, ids: string[] = []): BlogrollsData => ({
    blogrolls: ids.map((id) => card(id, id)),
    next,
  })

  test('a page is kept only where it carries on, and a fresh first page starts over', async () => {
    resetBlogrollsPages()
    const answers: Record<string, BlogrollsData> = {
      '/two': page('2:bbbbbbbbbbbb', ['bbbbbbbbbbbb']),
      '/three': page(null, ['cccccccccccc']),
    }
    const fetcher = ((url: string) =>
      Promise.resolve(Response.json(answers[url] ?? page(null)))) as unknown as typeof fetch
    const start = '9:aaaaaaaaaaaa'
    // Asked from a cursor the held pages do not end at: nothing is kept.
    await fetchMoreBlogrolls({ base: 'a', start, from: '1:x', url: '/two' }, fetcher)
    expect(heldBlogrolls('a')?.pages).toEqual([])
    await fetchMoreBlogrolls({ base: 'b', start, from: start, url: '/two' }, fetcher)
    expect(fetchingBlogrolls('b')).toBe(false)
    await fetchMoreBlogrolls({ base: 'b', start, from: '2:bbbbbbbbbbbb', url: '/three' }, fetcher)
    expect(heldBlogrolls('b')?.pages.map((p) => p.next)).toEqual(['2:bbbbbbbbbbbb', null])
    // The last page there is: nothing after it is appended again.
    await fetchMoreBlogrolls({ base: 'b', start, from: '2:bbbbbbbbbbbb', url: '/three' }, fetcher)
    expect(heldBlogrolls('b')?.pages).toHaveLength(2)
    // A first page that ends elsewhere starts the held pages over.
    await fetchMoreBlogrolls({ base: 'b', start: '8:x', from: '1:x', url: '/two' }, fetcher)
    expect(heldBlogrolls('b')).toEqual({ after: '8:x', pages: [] })
  })

  test('forgotten, the pages More brought go, an answer still out lands nowhere, and More asks again past the cache', async () => {
    resetBlogrollsPages()
    const page2 = page('2:bbbbbbbbbbbb', ['bbbbbbbbbbbb'])
    const inits: (RequestInit | undefined)[] = []
    let answer!: () => void
    const slow = new Promise<void>((resolve) => {
      answer = resolve
    })
    const fetcher = ((url: string, init?: RequestInit) => {
      inits.push(init)
      const page = Response.json(
        url === '/two' ? page2 : { blogrolls: [card('cccccccccccc', 'c')], next: null },
      )
      return url === '/slow' ? slow.then(() => page) : Promise.resolve(page)
    }) as unknown as typeof fetch
    const start = '9:aaaaaaaaaaaa'
    await fetchMoreBlogrolls({ base: 'b', start, from: start, url: '/two' }, fetcher)
    expect(heldBlogrolls('b')?.pages).toEqual([page2])
    const out = fetchMoreBlogrolls(
      { base: 'b', start, from: '2:bbbbbbbbbbbb', url: '/slow' },
      fetcher,
    )

    // One of the member's blogrolls changed: the first page is fetched again, and if it still
    // ends at `start`, nothing held may carry on from it.
    forgetDiscoverBlogrolls()
    expect(heldBlogrolls('b')).toBeUndefined()
    expect(fetchingBlogrolls('b')).toBe(false)
    answer()
    await out
    expect(heldBlogrolls('b')).toBeUndefined()

    await fetchMoreBlogrolls({ base: 'b', start, from: start, url: '/two' }, fetcher)
    expect(heldBlogrolls('b')?.pages).toEqual([page2])
    expect(inits.map((init) => init?.cache)).toEqual([undefined, undefined, 'reload'])
    resetBlogrollsPages()
  })

  test('list each blogroll once, where it first comes', () => {
    const first = page('2:b', ['aaaaaaaaaaaa', 'bbbbbbbbbbbb'])
    const second = page(null, ['bbbbbbbbbbbb', 'cccccccccccc'])
    expect(blogrollsList([first, second]).map((c) => c.id)).toEqual([
      'aaaaaaaaaaaa',
      'bbbbbbbbbbbb',
      'cccccccccccc',
    ])
  })
})

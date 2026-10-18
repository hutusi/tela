/**
 * Blogrolls in lists (ADR 0050): Discover's tab with the reasons a member's device puts on it, and
 * the pages "More" brings.
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
  forgetBlogrollsPages,
  heldBlogrolls,
} from '../src/lib/blogroll-pages'
import { DiscoverBlogrollsView } from '../src/views/discover-blogrolls'
import type { BlogrollCard, BlogrollsData, Person } from '../src/views/types'

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

const count = (html: string, needle: string) => html.split(needle).length - 1

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
    expect(reasons).toContain('You follow Ann K')
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
    forgetBlogrollsPages()
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

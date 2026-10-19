/**
 * A blogroll's page drawn on the server (ADR 0050): the guest's view the edge renders, a member's,
 * the owner's on a device that has not pulled it, and the owner's own from the store, with its
 * tools; then Subscribe to all's button and the New blogroll dialog. No effect runs in a server
 * render, so nothing opens, is pressed or is sent here; the e2e does that.
 */
import { describe, expect, test } from 'bun:test'
import {
  type BlogrollBlogRow,
  type BlogrollRow,
  emptyTables,
  type FeedRow,
  rowsOf,
  type SiteRow,
  type TableRows,
} from '@tela/sync'
import type { ReactNode } from 'react'
import { renderToString } from 'react-dom/server'
import { MemoryRouter, Route, Routes } from 'react-router'
import { BlogrollDialog } from '../src/components/blogroll-dialog'
import { SubscribeAll } from '../src/components/subscribe-all'
import { I18n } from '../src/i18n'
import { BlogrollPage } from '../src/pages/blogroll'
import { memoryPersistence, type Persistence, TABLES } from '../src/store/db'
import { type StoreHandle, StoreProvider } from '../src/store/hooks'
import { LocalStore } from '../src/store/local'
import { UiContext } from '../src/ui'
import { BlogrollView } from '../src/views/blogroll'
import type { BlogrollBlog, BlogrollData, MemberControls } from '../src/views/types'
import { DAY, NOW, profile, sub } from './rows'

const ID = 'Abc123def456'
const LOGIN = `/login?next=${encodeURIComponent(`/l/${ID}`)}`

const blog = (feedId: number, over: Partial<BlogrollBlog> = {}): BlogrollBlog => ({
  feedId,
  siteId: feedId + 10,
  name: `Blog ${feedId}`,
  homeUrl: `https://blog${feedId}.example/`,
  faviconKey: null,
  primaryLang: null,
  description: null,
  listed: false,
  readerCount: null,
  dead: false,
  note: null,
  addedAt: feedId,
  ...over,
})

const DATA: BlogrollData = {
  blogroll: {
    id: ID,
    name: 'Cities, on foot',
    description: 'Blogs by people who walk their cities.',
    updatedAt: NOW - 3 * DAY,
  },
  owner: { id: 'u-ana', handle: 'ana', displayName: 'Ana Ruiz', avatar: null },
  blogs: [
    blog(1, {
      name: 'Kilómetro Cero',
      listed: true,
      primaryLang: 'es',
      readerCount: 12,
      description: 'A city on foot.',
      note: 'Every Sunday.',
    }),
    blog(2, { name: null, homeUrl: 'https://www.kerb.example/', dead: true }),
  ],
}

/** React's markers between adjacent text are left out, so a line reads as it shows. */
const wrap = (node: ReactNode) =>
  renderToString(
    <I18n locale="en">
      <MemoryRouter>{node}</MemoryRouter>
    </I18n>,
  ).replaceAll('<!-- -->', '')

const count = (html: string, id: string) =>
  html.match(new RegExp(`data-testid="${id}"`, 'g'))?.length ?? 0

function member(subscribed: number[] = []): MemberControls {
  return {
    isSubscribed: (feedId) => subscribed.includes(feedId),
    toggle() {},
    readHref: () => '/reading',
    hold() {},
    handle: 'reader',
    userId: 'u-reader',
    isFollowing: () => false,
    setFollowing() {},
  }
}

describe("a guest's blogroll, as the edge renders it", () => {
  const html = wrap(<BlogrollView data={DATA} locale="en" now={NOW} />)

  test('its header: the eyebrow, the name, the description, whose it is and how many blogs', () => {
    expect(html).toContain('data-testid="blogroll-page"')
    expect(html).toContain('>Blogroll</span>')
    expect(html).toContain('Cities, on foot</h1>')
    expect(html).toContain('Blogs by people who walk their cities.')
    expect(html).toContain('href="/@ana"')
    expect(html).toContain('Ana Ruiz')
    expect(html).toContain('>2 blogs<')
  })

  test('Subscribe to all and each Subscribe sign in first, and come back here', () => {
    expect(html).toContain('Subscribe to all 2')
    expect(count(html, 'blogroll-subscribe-all')).toBe(1)
    expect(count(html, 'blogroll-row-subscribe')).toBe(2)
    expect(html.split(`href="${LOGIN}"`).length - 1).toBe(3)
  })

  test('a blog with a page on Tela links there; one without, to the blog itself', () => {
    expect(html).toContain('href="/s/11"')
    expect(html).toContain(
      'href="https://www.kerb.example/" target="_blank" rel="noopener noreferrer"',
    )
    // No name: its host.
    expect(html).toContain('>kerb.example</a>')
  })

  test('its language, address and readers, its tagline, a dead feed, and the note as written', () => {
    expect(html).toContain('>ES</span>')
    expect(html).toContain('blog1.example · 12 readers on Tela')
    expect(html).toContain('A city on foot.')
    expect(html).toContain('kerb.example · Not updating')
    expect(html).toContain('“Every Sunday.”')
    expect(count(html, 'blogroll-row')).toBe(2)
  })

  test('empty, it says so and offers nothing to subscribe to', () => {
    const empty = wrap(<BlogrollView data={{ ...DATA, blogs: [] }} locale="en" now={NOW} />)
    expect(empty).toContain('No blogs here yet.')
    expect(empty).toContain('>0 blogs<')
    expect(empty).not.toContain('/login?next')
    expect(count(empty, 'blogroll-subscribe-all')).toBe(0)
  })
})

describe("a member's view of someone else's blogroll", () => {
  test('each row subscribes in place, and says which they follow', () => {
    const html = wrap(
      <BlogrollView
        data={DATA}
        member={member([1])}
        locale="en"
        now={NOW}
        subscribe={<span data-testid="slot" />}
      />,
    )
    expect(html).not.toContain('/login?next')
    expect(count(html, 'slot')).toBe(1)
    expect(html).toMatch(/aria-pressed="true"[^>]*data-testid="blogroll-row-subscribe"/)
    expect(html).toMatch(/aria-pressed="false"[^>]*data-testid="blogroll-row-subscribe"/)
    expect(html).toContain('Subscribed</button>')
  })

  test('the owner, on a device that has not pulled it yet, has nothing to press', () => {
    const html = wrap(<BlogrollView data={DATA} locale="en" now={NOW} readOnly />)
    expect(html).not.toContain('/login?next')
    expect(count(html, 'blogroll-row-subscribe')).toBe(0)
    expect(count(html, 'blogroll-subscribe-all')).toBe(0)
  })

  test("the owner's slots take a row's action, note and the end of its meta", () => {
    const html = wrap(
      <BlogrollView
        data={DATA}
        locale="en"
        now={NOW}
        ownerHeader={<span data-testid="tools" />}
        ownerRow={(b) => ({
          action: <button type="button" data-testid="remove" />,
          note: <span data-testid="note-slot" />,
          meta: b.feedId === 2 ? 'Not in your subscriptions' : undefined,
        })}
      />,
    )
    expect(count(html, 'tools')).toBe(1)
    expect(count(html, 'remove')).toBe(2)
    expect(count(html, 'note-slot')).toBe(2)
    expect(html).not.toContain('“Every Sunday.”')
    expect(html).toContain('kerb.example · Not updating · Not in your subscriptions')
    expect(count(html, 'blogroll-row-subscribe')).toBe(0)
  })
})

// ---------------------------------------------------------------------------------------------
// From the store

const feedRow = (id: number, siteId: number): FeedRow => ({
  id,
  siteId,
  feedUrl: `https://site${siteId}.example/feed.xml`,
  title: null,
  status: 'active',
  lastFetchedAt: null,
  lastError: null,
  seq: 1,
})

const siteRow = (id: number, over: Partial<SiteRow> = {}): SiteRow => ({
  id,
  homeUrl: `https://site${id}.example/`,
  title: `Site ${id}`,
  description: null,
  faviconKey: null,
  primaryLang: 'en',
  listing: 'listed',
  owned: false,
  claimed: false,
  readerCount: 0,
  translationOptOut: false,
  seq: 1,
  ...over,
})

const rollRow = (feedId: number, over: Partial<BlogrollBlogRow> = {}): BlogrollBlogRow => ({
  blogrollId: ID,
  feedId,
  note: null,
  noteAt: 0,
  addedAt: feedId,
  updatedAt: feedId,
  removedAt: null,
  seq: 2,
  ...over,
})

const ownRow = (over: Partial<BlogrollRow> = {}): BlogrollRow => ({
  id: ID,
  name: 'Cities, on foot',
  description: '',
  isPublic: false,
  publicVersion: 0,
  createdAt: 1,
  updatedAt: 1,
  deletedAt: null,
  seq: 2,
  ...over,
})

/** A device that holds these rows, as a reload finds them. */
async function storeWith(rows: Partial<TableRows>): Promise<LocalStore> {
  const full = { ...rowsOf(emptyTables()), ...rows } as TableRows
  const persistence: Persistence = {
    ...memoryPersistence(),
    load: async () => ({
      owner: 'u-ana',
      unverified: null,
      cursor: 5,
      rows: full,
      covered: [...TABLES],
      titles: { lang: null, whole: true },
      pending: [],
    }),
  }
  const store = new LocalStore(persistence, () => NOW)
  await store.open()
  return store
}

function withStore(store: LocalStore, node: ReactNode, entry: string | object = '/') {
  const handle = { store, engine: {}, objects: {} } as unknown as StoreHandle
  return renderToString(
    <I18n locale="en">
      <UiContext.Provider value={{ locale: 'en', setLocale() {} }}>
        <StoreProvider value={handle}>
          <MemoryRouter initialEntries={[entry as string]}>{node}</MemoryRouter>
        </StoreProvider>
      </UiContext.Provider>
    </I18n>,
  ).replaceAll('<!-- -->', '')
}

const page = (store: LocalStore, state?: object) =>
  withStore(
    store,
    <Routes>
      <Route path="/l/:id" element={<BlogrollPage />} />
    </Routes>,
    state ? { pathname: `/l/${ID}`, state } : `/l/${ID}`,
  )

const OWN = {
  profile: [{ ...profile, handle: 'ana', displayName: 'Ana Ruiz' }][0] ?? null,
  blogrolls: [ownRow()],
  blogrollBlogs: [rollRow(1, { note: 'Every Sunday.', noteAt: 5 }), rollRow(2)],
  feeds: [feedRow(1, 11), feedRow(2, 12)],
  sites: [siteRow(11), siteRow(12)],
  subscriptions: [sub(1)],
}

describe("the owner's own blogroll, from the store", () => {
  test('its tools under the title, and each row with Remove and its note', async () => {
    const html = page(await storeWith(OWN))
    expect(html).toContain('data-testid="blogroll-page"')
    // Said, not switched: it changes in Edit.
    expect(html).toContain('<span class="sr-only">Who can see it: Private</span>')
    expect(html).not.toContain('blogroll-public-toggle')
    for (const id of ['blogroll-visibility', 'blogroll-edit', 'blogroll-add-blogs']) {
      expect(count(html, id)).toBe(1)
    }
    expect(count(html, 'blogroll-copy-link')).toBe(1)
    expect(count(html, 'blogroll-remove')).toBe(2)
    expect(html).toContain('aria-label="Remove Site 11 from this blogroll"')
    // The note, which opens its editor, and Add a note under the blog without one.
    expect(count(html, 'blogroll-note')).toBe(2)
    expect(html).toContain('“Every Sunday.”')
    expect(html).toContain('Add a note</button>')
    // Only the owner is told they no longer follow one of its blogs.
    expect(html).toContain('site12.example · Not in your subscriptions')
    expect(html).toContain('Only you can see this blogroll. Make it public to share it.')
    expect(html).not.toContain('/login?next')
    expect(count(html, 'blogroll-row-subscribe')).toBe(0)
    expect(count(html, 'blogroll-subscribe-all')).toBe(0)
    // Add blogs is closed until pressed.
    expect(count(html, 'add-blogs')).toBe(0)
  })

  test('public, it says so', async () => {
    const html = page(await storeWith({ ...OWN, blogrolls: [ownRow({ isPublic: true })] }))
    expect(html).toContain('<span class="sr-only">Who can see it: Public</span>')
    expect(html).toContain('Public. It shows on your profile and can appear in Discover.')
  })

  test('made just now with nothing in it, it opens on Add blogs, each subscription a tick box', async () => {
    const html = page(await storeWith({ ...OWN, blogrollBlogs: [] }), { addBlogs: true })
    expect(count(html, 'add-blogs')).toBe(1)
    expect(html).toContain('Add from your subscriptions')
    expect(count(html, 'add-blogs-item')).toBe(1)
    expect(count(html, 'add-blogs-filter')).toBe(1)
    expect(html).toContain('No blogs yet')
    expect(html).toContain('Unsubscribing from a blog later doesn’t take it out of this blogroll.')
  })

  test('empty, with Add blogs closed, it offers to open it', async () => {
    const html = page(await storeWith({ ...OWN, blogrollBlogs: [rollRow(1, { removedAt: 9 })] }))
    expect(count(html, 'blogroll-empty')).toBe(1)
    expect(count(html, 'blogroll-empty-add')).toBe(1)
    expect(count(html, 'blogroll-row')).toBe(0)
  })

  test('an address that is not a blogroll id is not found, with no request', async () => {
    const html = withStore(
      await storeWith(OWN),
      <Routes>
        <Route path="/l/:id" element={<BlogrollPage />} />
      </Routes>,
      '/l/not-an-id',
    )
    expect(html).toContain('data-testid="not-found"')
  })
})

describe('Subscribe to all', () => {
  const data: BlogrollData = { ...DATA, blogs: [blog(1), blog(2), blog(3)] }
  const button = async (rows: Partial<TableRows>) =>
    withStore(await storeWith(rows), <SubscribeAll data={data} />)

  test('counts what it adds: every blog, those not followed yet, or none', async () => {
    const all = await button({ profile })
    expect(all).toContain('Subscribe to all 3')
    expect(all).not.toContain('disabled=""')
    expect(await button({ profile, subscriptions: [sub(2)] })).toContain('Subscribe to 2</button>')
    const none = await button({ profile, subscriptions: [sub(1), sub(2), sub(3)] })
    expect(none).toContain('Subscribed to all')
    // Said, not disabled: subscribing turns the button to it, and its focus must stay there.
    expect(none).toContain('aria-disabled="true"')
    expect(none).not.toContain('disabled=""')
  })

  test("waits for the device's first pull, which says what is followed already", async () => {
    const html = await button({})
    expect(html).toContain('disabled=""')
    expect(html).toContain('title="Your subscriptions are still loading."')
  })
})

describe('New blogroll and Edit blogroll', () => {
  test('from a folder: its name, and how many of its blogs it starts with', async () => {
    const store = await storeWith(OWN)
    const html = withStore(
      store,
      <BlogrollDialog initial={{ name: 'Cities', feedIds: [1, 2, 3] }} onClose={() => {}} />,
    )
    expect(html).toContain('data-testid="blogroll-dialog"')
    expect(html).toContain('New blogroll')
    expect(html).toContain('data-testid="blogroll-dialog-name" value="Cities"')
    expect(html).toContain('placeholder="Slow blogs I read first"')
    expect(html).toContain('It starts with the folder’s 3 blogs.')
    expect(html).toContain('Only you can see it.')
    expect(html).toContain('On your profile and in Discover. Others can subscribe to every blog.')
    expect(html).toContain('>Create</button>')
    expect(count(html, 'blogroll-delete')).toBe(0)
    const big = withStore(
      store,
      <BlogrollDialog
        initial={{ name: 'Everything', feedIds: Array.from({ length: 250 }, (_, i) => i + 1) }}
        onClose={() => {}}
      />,
    )
    expect(big).toContain(
      'The folder has 250 blogs. A blogroll holds 200, so it starts with the first 200 by name.',
    )
  })

  test('editing: what it is called and says, Save, and Delete blogroll', async () => {
    const store = await storeWith({ ...OWN, blogrolls: [ownRow({ description: 'On foot.' })] })
    const html = withStore(store, <BlogrollDialog editing={ID} onClose={() => {}} />)
    expect(html).toContain('Edit blogroll')
    expect(html).toContain('data-testid="blogroll-dialog-name" value="Cities, on foot"')
    expect(html).toContain('On foot.</textarea>')
    expect(html).toContain('>Save</button>')
    expect(count(html, 'blogroll-delete')).toBe(1)
    expect(count(html, 'blogroll-dialog-public')).toBe(1)
  })
})

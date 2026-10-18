/**
 * Blogrolls (ADR 0050):
 * - the owner makes one from their profile's Blogrolls tab, fills it from Add blogs (a filter that
 *   ignores accents and case), writes a note, removes a blog and takes it back while the toast
 *   shows, makes it public and copies its link; edits, deletes and undeletes it;
 * - a folder in Settings makes one, and a blog the owner leaves stays in it;
 * - another member subscribes to all of it into a new folder: Undo takes the whole group back
 *   unsent, and let go it reaches tela-api;
 * - a visitor gets the edge's page, with links to sign in, and a private blogroll is a 404 to
 *   anyone but its owner, whose device renders it over that 404;
 * - a profile shows a visitor its Blogrolls tab only for a public blogroll; Discover lists one of
 *   three blogs and not one of two; the operator hides one from Discover and restores it;
 * - on a phone the panels and the dialog are sheets, a folder's ··· makes a blogroll, Discover's
 *   tabs scroll, and nothing scrolls sideways at 320px.
 *
 * Each test signs in members of its own, each from an address of its own (sign-in is limited per
 * IP and per address), and each leaves when the test ends, passed or not: its blogrolls deleted
 * and the fixture blogs unsubscribed. The fixture blogs are one site, which the setup's member
 * reads too, and other specs count its readers (from three a count is published, ADR 0041), so no
 * test has two of its members reading it at once: an owner whose blogroll others visit reads none
 * of it, since a blogroll never needs its owner to read what it holds.
 */
import {
  type APIRequestContext,
  request as apiRequest,
  type Browser,
  type BrowserContext,
  expect,
  type Page,
  test,
} from '@playwright/test'
import type { BlogrollData, BlogrollsData, ProfileData } from '../src/views/types'
import {
  ADMIN_TOKEN,
  addFeed,
  BASE,
  cycle,
  FIXTURES,
  memberHeaders,
  noSidewaysScroll,
  signInRequest,
} from './helpers'

test.use({ storageState: { cookies: [], origins: [] } })

const ORIGIN = { origin: BASE }
/** The fixture blogs, by the names a blogroll gives them: one site, so each by its feed's title. */
const JVNS = 'Julia Evans'
const JNITO = 'give IT a try'
const HUTUSI = '胡涂说'
const NOTE = 'Short posts that each teach one thing.'
/** Names this run's blogrolls apart from any other's. */
const RUN = Date.now().toString(36).slice(-5)
/** A blogroll's page, where it moved to after New blogroll or Make a blogroll. */
const BLOGROLL_URL = /\/l\/([A-Za-z0-9]{12})$/

type Feeds = { jvns: number; jnito: number; hutusi: number }
type Blog = keyof Feeds
const BLOGS: Blog[] = ['jvns', 'jnito', 'hutusi']
const PATHS: Record<Blog, string> = {
  jvns: '/jvns.xml',
  jnito: '/jnito.xml',
  hutusi: '/hutusi.xml',
}

let members = 0
/** The fixture blogs' feed ids once a member has learned them: Tela's, so the same for everyone. */
let known: Feeds | null = null
/** What each test's members must undo when it ends. */
const leave: (() => Promise<void>)[] = []
test.afterEach(async () => {
  for (const undo of leave.splice(0)) await undo()
})

type Member = { context: BrowserContext; page: Page; feeds: Feeds; handle: string }

/**
 * A new member on a page of their own, with a handle of their own, reading the fixture blogs
 * named in `reads` (all three unless told). Adding a feed is how a member learns its id: Tela has
 * it already, so it only subscribes; a blog the member is not to read is left again at once.
 */
async function member(
  browser: Browser,
  options: { reads?: Blog[]; width?: number; admin?: boolean } = {},
): Promise<Member> {
  const n = ++members
  const context = await browser.newContext({
    baseURL: BASE,
    extraHTTPHeaders: { 'cf-connecting-ip': `198.51.100.${120 + n}` },
    ...(options.width ? { viewport: { width: options.width, height: 860 } } : {}),
  })
  const email = `blogrolls-${n}-${Date.now()}@e2e.test`
  await signInRequest(context.request, email)
  const reads = options.reads ?? BLOGS
  const ids: Partial<Feeds> = {}
  const added: number[] = []
  for (const blog of BLOGS) {
    if (!reads.includes(blog) && known) {
      ids[blog] = known[blog]
      continue
    }
    const { feedId } = await addFeed(context.request, `${FIXTURES}${PATHS[blog]}`)
    ids[blog] = feedId
    added.push(feedId)
  }
  const feeds = ids as Feeds
  known = feeds
  // Left again whatever happens next, so no later spec counts this member as a reader.
  leave.push(async () => {
    const { blogrolls } = await onServer(context.request)
    await push(context.request, [
      ...blogrolls.map((b) => ({ type: 'deleteBlogroll', id: b.id })),
      ...BLOGS.map((blog) => ({ type: 'unsubscribe', feedId: feeds[blog] })),
    ])
    await context.close()
  })
  const unread = BLOGS.filter((blog) => !reads.includes(blog) && added.includes(feeds[blog]))
  if (unread.length > 0) {
    await push(
      context.request,
      unread.map((blog) => ({ type: 'unsubscribe', feedId: feeds[blog] })),
    )
  }
  const handle = `rolls${n}_${Date.now().toString(36)}`
  const named = await context.request.put(`${BASE}/api/v1/profile`, {
    headers: { ...ORIGIN, ...(await memberHeaders(context.request)) },
    data: { handle, displayName: `Roller ${n}` },
  })
  expect(named.ok()).toBe(true)
  if (options.admin) {
    const granted = await context.request.post(`${BASE}/api/admin/admins`, {
      headers: { ...ORIGIN, authorization: `Bearer ${ADMIN_TOKEN}` },
      data: { email, admin: true },
    })
    expect(granted.ok()).toBe(true)
  }
  await cycle(context.request)
  return { context, page: await context.newPage(), feeds, handle }
}

/**
 * Changes made as another device makes them: straight to tela-api, each a millisecond after the
 * last, so blogs put in one push keep their order. None may be refused: an older tela-api refuses
 * the blogroll mutations as invalid.
 */
async function push(
  to: Page | APIRequestContext,
  mutations: Record<string, unknown>[],
): Promise<void> {
  const request = 'request' in to ? to.request : to
  const now = Date.now()
  const res = await request.post(`${BASE}/api/v1/mutations`, {
    headers: { ...ORIGIN, ...(await memberHeaders(request)) },
    data: {
      mutations: mutations.map((m, i) => ({
        mid: crypto.randomUUID(),
        at: now - mutations.length + i,
        ...m,
      })),
    },
  })
  expect(res.ok()).toBe(true)
  expect(((await res.json()) as { rejected: unknown[] }).rejected).toEqual([])
}

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
/** A blogroll id as the device mints one: twelve letters and digits. */
const newId = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => ALPHABET[b % 62]).join('')

/** A blogroll made on another device, holding these feeds in this order; its id. */
async function blogroll(
  to: Page,
  feedIds: number[],
  options: { name: string; description?: string; isPublic?: boolean; notes?: [number, string][] },
): Promise<string> {
  const id = newId()
  await push(to, [
    {
      type: 'putBlogroll',
      id,
      name: options.name,
      description: options.description ?? '',
      isPublic: options.isPublic ?? false,
    },
    ...feedIds.map((feedId) => ({ type: 'rollBlog', blogrollId: id, feedId })),
    ...(options.notes ?? []).map(([feedId, note]) => ({
      type: 'noteBlog',
      blogrollId: id,
      feedId,
      note,
    })),
  ])
  return id
}

type Rows = {
  blogrolls: { id: string; name: string; isPublic: boolean }[]
  blogrollBlogs: {
    blogrollId: string
    feedId: number
    note: string | null
    removedAt: number | null
  }[]
  folders: { id: string; name: string }[]
  feedFolders: { feedId: number; folderId: string | null }[]
  subscriptions: { feedId: number; deletedAt: number | null }[]
}

/** What tela-api holds of the member's own, through a snapshot pull. */
async function onServer(request: APIRequestContext): Promise<Rows> {
  const res = await request.get(`${BASE}/api/v1/sync?cursor=0`, {
    headers: await memberHeaders(request),
  })
  expect(res.ok()).toBe(true)
  const { rows } = (await res.json()) as { rows: Partial<Rows> }
  return {
    blogrolls: rows.blogrolls ?? [],
    blogrollBlogs: rows.blogrollBlogs ?? [],
    folders: rows.folders ?? [],
    feedFolders: rows.feedFolders ?? [],
    subscriptions: rows.subscriptions ?? [],
  }
}

/** Whether tela-api holds the member's blogroll as public. */
const isPublicOnServer = async (page: Page, id: string) =>
  (await onServer(page.request)).blogrolls.find((b) => b.id === id)?.isPublic ?? null

/** A public answer, as anyone gets it, with no cookie; null for a 404. */
async function asGuest<T>(path: string): Promise<T | null> {
  const guest = await apiRequest.newContext({ baseURL: BASE })
  try {
    const res = await guest.get(path)
    if (res.status() === 404) return null
    expect(res.ok(), `${path} answered ${res.status()}`).toBe(true)
    return (await res.json()) as T
  } finally {
    await guest.dispose()
  }
}

const publicBlogroll = (id: string) => asGuest<BlogrollData>(`/api/v1/public/blogrolls/${id}`)

/** The ids Discover's Blogrolls tab lists, every page of it. */
async function inDiscover(): Promise<string[]> {
  const ids: string[] = []
  let cursor: string | null = null
  for (let pages = 0; pages < 10; pages++) {
    const query: string = cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''
    const answer = await asGuest<BlogrollsData>(`/api/v1/public/discover/blogrolls${query}`)
    if (!answer) throw new Error("Discover's Blogrolls answered 404")
    ids.push(...answer.blogrolls.map((b) => b.id))
    cursor = answer.next
    if (!cursor) break
  }
  return ids
}

/** The ids of the blogrolls a profile shows anyone. */
async function onProfile(handle: string): Promise<string[]> {
  const profile = await asGuest<ProfileData>(`/api/v1/public/profiles/${handle}`)
  return (profile?.blogrolls ?? []).map((b) => b.id)
}

/** The mutations the page pushes, by type, as they go. */
function pushes(page: Page): string[] {
  const types: string[] = []
  page.on('request', (r) => {
    if (!r.url().includes('/api/v1/mutations')) return
    const body = JSON.parse(r.postData() ?? '{}') as { mutations?: { type: string }[] }
    for (const m of body.mutations ?? []) types.push(m.type)
  })
  return types
}

/** The id at the end of the page's address, once it is a blogroll's. */
async function blogrollId(page: Page): Promise<string> {
  await expect(page).toHaveURL(BLOGROLL_URL)
  return page.url().match(BLOGROLL_URL)?.[1] ?? ''
}

/** A folder's section in Settings › Subscriptions below `lg`, by its name. */
const settingsGroup = (page: Page, name: string) =>
  page.getByTestId('folder-group').filter({ has: page.getByRole('heading', { name, exact: true }) })

test.describe('a blogroll of my own', () => {
  test('made from my profile, filled from Add blogs, a note, a removal undone, made public, its link copied', async ({
    browser,
  }) => {
    const { context, page, feeds, handle } = await member(browser)
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE })
    const sent = pushes(page)
    await page.goto(`/@${handle}`)
    // One's own profile always has the tab, with New blogroll.
    await page.getByTestId('profile-tab-blogrolls').click()
    await expect(page).toHaveURL(/[?&]tab=blogrolls/)
    await page.getByTestId('new-blogroll').click()
    const dialog = page.getByTestId('blogroll-dialog')
    await expect(dialog).toBeVisible()
    // Private unless the member chooses Public.
    await expect(dialog.getByTestId('blogroll-dialog-public')).not.toBeChecked()
    const name = `Slow reads ${RUN}`
    await dialog.getByTestId('blogroll-dialog-name').fill(name)
    await dialog.getByTestId('blogroll-dialog-submit').click()

    // Its page, with Add blogs open, inline from md: no sheet.
    const id = await blogrollId(page)
    const view = page.getByTestId('blogroll-page')
    await expect(view.getByRole('heading', { level: 1 })).toHaveText(name)
    const add = page.getByTestId('add-blogs')
    await expect(add).toBeVisible()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    const items = add.getByTestId('add-blogs-item')
    await expect(items).toHaveText([new RegExp(JNITO), new RegExp(JVNS), new RegExp(HUTUSI)])

    // The filter is Settings' own: accents and case aside.
    const filter = add.getByTestId('add-blogs-filter')
    for (const [query, blog] of [
      [HUTUSI, HUTUSI],
      ['julia', JVNS],
      ['JULIA', JVNS],
      ['JÚLIA', JVNS],
    ] as const) {
      await filter.fill(query)
      await expect(items).toHaveText([new RegExp(blog)])
    }
    await filter.fill('nothing like it')
    await expect(items).toHaveCount(0)
    await expect(add).toContainText('No subscriptions match.')
    await filter.fill('')
    await expect(items).toHaveCount(3)

    // A tick puts a blog in at once, and says it is in.
    const item = (blog: string) => items.filter({ hasText: blog })
    await item(JVNS).click()
    await expect(item(JVNS)).toBeChecked()
    await item(JNITO).click()
    await expect(item(JNITO)).toBeChecked()
    await expect(item(HUTUSI)).not.toBeChecked()
    const rows = view.getByTestId('blogroll-row')
    await expect(rows).toHaveText([new RegExp(JVNS), new RegExp(JNITO)])

    // A note on one, saved at once.
    const jvnsRow = rows.filter({ hasText: JVNS })
    await jvnsRow.getByTestId('blogroll-note').click()
    await jvnsRow.getByTestId('blogroll-note-input').fill(NOTE)
    await jvnsRow.getByTestId('blogroll-note-save').click()
    await expect(jvnsRow.getByTestId('blogroll-note-input')).toHaveCount(0)
    await expect(jvnsRow.getByTestId('blogroll-note')).toContainText(NOTE)
    await expect
      .poll(
        async () =>
          (await onServer(page.request)).blogrollBlogs.find(
            (b) => b.blogrollId === id && b.feedId === feeds.jvns,
          )?.note,
        { timeout: 15_000 },
      )
      .toBe(NOTE)

    // Removed, and taken back while its toast shows: nothing was sent.
    // By feed: with one fixture feed left, the blogroll names it by the blog the fixtures share.
    const shownFeeds = () =>
      rows.evaluateAll((els) => els.map((e) => e.getAttribute('data-feed-id')))
    await rows.filter({ hasText: JNITO }).getByTestId('blogroll-remove').click()
    await expect.poll(shownFeeds).toEqual([String(feeds.jvns)])
    const toast = page.getByTestId('toast')
    await toast.getByTestId('toast-action').click()
    await expect(rows).toHaveText([new RegExp(JVNS), new RegExp(JNITO)])
    expect(sent).not.toContain('unrollBlog')

    // Public: tela-api holds it so, and anyone can read it, its note with it.
    const pill = view.getByTestId('blogroll-public-toggle')
    await expect(pill).toContainText('Private')
    await pill.click()
    await expect(pill).toContainText('Public')
    await expect.poll(() => isPublicOnServer(page, id), { timeout: 15_000 }).toBe(true)
    const shown = await publicBlogroll(id)
    expect(shown?.blogroll.name).toBe(name)
    expect(shown?.blogs.map((b) => [b.feedId, b.note])).toEqual([
      [feeds.jvns, NOTE],
      [feeds.jnito, null],
    ])

    await view.getByTestId('blogroll-copy-link').click()
    await expect(toast).toBeVisible()
    expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(
      new RegExp(`/l/${id}$`),
    )
  })

  test('ticking a blog far down Add blogs leaves the page where it is', async ({ browser }) => {
    const { page } = await member(browser)
    const id = await blogroll(page, [], { name: `Long list ${RUN}` })
    await page.goto(`/l/${id}`)
    await page.getByTestId('blogroll-add-blogs').click()
    const add = page.getByTestId('add-blogs')
    const items = add.getByTestId('add-blogs-item')
    await expect(items).toHaveCount(3)
    // The list as a member with many subscriptions has it: scrolled, and its foot at the window's.
    // Each row's box is hidden, and it once sat where its row would be with the list not
    // scrolled: ticking a row far down put focus below the window, and the page jumped to it.
    const list = add.locator('ul')
    await list.evaluate((el) => {
      el.style.maxHeight = '48px'
      el.scrollTop = el.scrollHeight
    })
    const foot = await list.evaluate((el) => el.getBoundingClientRect().bottom)
    await page.setViewportSize({ width: 1280, height: Math.ceil(foot) + 2 })
    const last = items.last()
    const box = await last.boundingBox()
    if (!box) throw new Error('the last row has no box')
    const before = await page.evaluate(() => window.scrollY)
    // A pointer's click: Playwright's own scrolls a row the list clips into view first.
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
    await expect(last.getByRole('checkbox')).toBeChecked()
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(before)
  })

  test('a folder in Settings makes one, and a blog I leave stays in it', async ({ browser }) => {
    const { page, feeds } = await member(browser)
    const folderId = `e2e-roll-folder-${RUN}`
    await push(page, [
      { type: 'putFolder', id: folderId, name: 'Cities' },
      { type: 'fileFeed', feedId: feeds.jvns, folderId },
      { type: 'fileFeed', feedId: feeds.jnito, folderId },
    ])
    // The manager, from lg up: a toolbar button beside Rename and Delete folder.
    await page.goto('/settings/subscriptions')
    await page
      .getByTestId('subscriptions-manager')
      .getByTestId('place')
      .filter({ hasText: 'Cities' })
      .click()
    await expect(page.getByTestId('manager-title')).toHaveText('Cities')
    await page.getByTestId('folder-make-blogroll').click()
    const dialog = page.getByTestId('blogroll-dialog')
    await expect(dialog.getByTestId('blogroll-dialog-name')).toHaveValue('Cities')
    await expect(dialog.getByTestId('blogroll-dialog-public')).not.toBeChecked()
    await dialog.getByTestId('blogroll-dialog-submit').click()

    const id = await blogrollId(page)
    const view = page.getByTestId('blogroll-page')
    const rows = view.getByTestId('blogroll-row')
    await expect(rows).toHaveCount(2)
    await expect(rows.filter({ hasText: JVNS })).toHaveCount(1)
    await expect(rows.filter({ hasText: JNITO })).toHaveCount(1)
    await expect(view.getByTestId('blogroll-public-toggle')).toContainText('Private')
    await expect(view).not.toContainText('Not in your subscriptions')
    await expect
      .poll(
        async () =>
          (await onServer(page.request)).blogrollBlogs
            .filter((b) => b.blogrollId === id && b.removedAt === null)
            .map((b) => b.feedId)
            .sort((a, b) => a - b),
        { timeout: 15_000 },
      )
      .toEqual([feeds.jvns, feeds.jnito].sort((a, b) => a - b))

    // Left on another device: a blogroll recommends, it does not mirror subscriptions. The blog
    // stays, and says its owner no longer reads it.
    await push(page, [{ type: 'unsubscribe', feedId: feeds.jvns }])
    await page.reload()
    await expect(rows).toHaveCount(2)
    await expect(rows.filter({ hasText: JVNS })).toContainText('Not in your subscriptions')
    await expect(rows.filter({ hasText: JNITO })).not.toContainText('Not in your subscriptions')
  })

  test('a private blogroll is a 404 at the edge, and my device renders it over that; edited, deleted and undeleted', async ({
    browser,
  }) => {
    const { page, feeds } = await member(browser)
    const name = `Just mine ${RUN}`
    const id = await blogroll(page, [feeds.jvns, feeds.hutusi], { name })
    const res = await page.goto(`/l/${id}`)
    expect(res?.status()).toBe(404)
    const view = page.getByTestId('blogroll-page')
    await expect(view.getByRole('heading', { level: 1 })).toHaveText(name)
    await expect(view.getByTestId('blogroll-public-toggle')).toContainText('Private')
    await expect(view.getByTestId('blogroll-row')).toHaveCount(2)
    await expect(page.getByTestId('not-found')).toHaveCount(0)

    // Edit renames it in place.
    await view.getByTestId('blogroll-edit').click()
    const dialog = page.getByTestId('blogroll-dialog')
    await expect(dialog.getByTestId('blogroll-dialog-name')).toHaveValue(name)
    await dialog.getByTestId('blogroll-dialog-name').fill(`${name}, renamed`)
    await dialog.getByTestId('blogroll-dialog-submit').click()
    await expect(dialog).toHaveCount(0)
    await expect(view.getByRole('heading', { level: 1 })).toHaveText(`${name}, renamed`)

    // Deleted, it is held while its toast shows, and the page goes to the Blogrolls tab; Undo
    // brings it back unsent.
    const sent = pushes(page)
    await view.getByTestId('blogroll-edit').click()
    await dialog.getByTestId('blogroll-delete').click()
    await expect(page).toHaveURL(/\/@[^/?]+\?tab=blogrolls$/)
    const toast = page.getByTestId('toast')
    await toast.getByTestId('toast-action').click()
    const card = page.getByTestId('blogroll-card').filter({ hasText: `${name}, renamed` })
    await expect(card).toHaveCount(1)
    expect(sent).not.toContain('deleteBlogroll')

    // Deleted for good once the toast goes, on tela-api too.
    await card.click()
    await expect(page).toHaveURL(new RegExp(`/l/${id}$`))
    await view.getByTestId('blogroll-edit').click()
    await dialog.getByTestId('blogroll-delete').click()
    await expect(toast).toHaveCount(0, { timeout: 10_000 })
    await expect
      .poll(async () => (await onServer(page.request)).blogrolls.map((b) => b.id), {
        timeout: 15_000,
      })
      .not.toContain(id)
  })
})

test.describe("someone else's blogroll", () => {
  test('Subscribe to all counts what it adds and files it in a new folder; Undo takes it all back, and let go it lands', async ({
    browser,
  }) => {
    const owner = await member(browser, { reads: [] })
    const name = `Cities on foot ${RUN}`
    const id = await blogroll(
      owner.page,
      [owner.feeds.jvns, owner.feeds.jnito, owner.feeds.hutusi],
      { name, isPublic: true, notes: [[owner.feeds.jnito, NOTE]] },
    )
    const { page, feeds } = await member(browser, { reads: ['jvns'] })
    const sent = pushes(page)
    await page.goto(`/l/${id}`)
    const view = page.getByTestId('blogroll-page')
    await expect(view.getByRole('heading', { level: 1 })).toHaveText(name)
    const rows = view.getByTestId('blogroll-row')
    await expect(rows).toHaveCount(3)
    await expect(rows.filter({ hasText: JNITO })).toContainText(NOTE)
    // Not the owner's page: no tools of theirs, and Subscribe on each row.
    await expect(view.getByTestId('blogroll-public-toggle')).toHaveCount(0)
    await expect(view.getByTestId('blogroll-remove')).toHaveCount(0)
    await expect(view.getByTestId('blogroll-row-subscribe')).toHaveCount(3)

    // It counts what it adds: the member reads one of the three already.
    const all = view.getByTestId('blogroll-subscribe-all')
    await expect(all).toHaveText(/Subscribe to 2\b/)
    await all.click()
    const panel = page.getByTestId('subscribe-all-panel')
    await expect(panel).toBeVisible()
    await expect(panel).toContainText(`You already subscribe to ${JVNS}`)
    // Into a new folder named after the blogroll, unless the member chooses otherwise.
    await expect(panel.getByTestId('subscribe-all-folder-name')).toHaveValue(name)
    await panel.getByTestId('subscribe-all-submit').click()
    await expect(panel).toHaveCount(0)
    await expect(all).toHaveText(/Subscribed to all/)

    // Held while its toast shows: Undo takes back every part of it, and nothing was sent.
    const toast = page.getByTestId('toast')
    await toast.getByTestId('toast-action').click()
    await expect(all).toHaveText(/Subscribe to 2\b/)
    expect(sent.filter((type) => ['subscribe', 'putFolder', 'fileFeed'].includes(type))).toEqual([])

    // Again, and let go: both blogs are followed, and only they are filed in the new folder.
    await all.click()
    await panel.getByTestId('subscribe-all-submit').click()
    await expect(all).toHaveText(/Subscribed to all/)
    await expect(toast).toHaveCount(0, { timeout: 10_000 })
    const byId = (a: number, b: number) => a - b
    await expect
      .poll(
        async () => {
          const held = await onServer(page.request)
          const folder = held.folders.find((f) => f.name === name)
          return {
            folder: folder?.name ?? null,
            subscribed: held.subscriptions
              .filter((s) => s.deletedAt === null)
              .map((s) => s.feedId)
              .sort(byId),
            filed: held.feedFolders
              .filter((f) => folder !== undefined && f.folderId === folder.id)
              .map((f) => f.feedId)
              .sort(byId),
          }
        },
        { timeout: 15_000 },
      )
      .toEqual({
        folder: name,
        subscribed: [feeds.jvns, feeds.jnito, feeds.hutusi].sort(byId),
        filed: [feeds.jnito, feeds.hutusi].sort(byId),
      })
    // It copied once: the blogroll is the owner's still, and nothing of the member's is in it.
    expect((await publicBlogroll(id))?.blogs).toHaveLength(3)
  })

  test('a visitor gets the edge’s page with links to sign in, and a private blogroll is a 404', async ({
    browser,
  }) => {
    const { page, feeds } = await member(browser, { reads: [] })
    const name = `Kerb notes ${RUN}`
    const id = await blogroll(page, [feeds.jvns, feeds.jnito, feeds.hutusi], {
      name,
      description: 'Blogs about walking a city.',
      isPublic: true,
      notes: [[feeds.hutusi, NOTE]],
    })
    const hidden = await blogroll(page, [feeds.jvns], { name: `Not yet ${RUN}` })
    const next = `/login?next=${encodeURIComponent(`/l/${id}`)}`

    const guest = await apiRequest.newContext({ baseURL: BASE })
    try {
      const res = await guest.get(`/l/${id}`)
      expect(res.status()).toBe(200)
      expect(res.headers()['x-robots-tag']).toBe('noindex, nofollow')
      const html = await res.text()
      expect(html).toMatch(new RegExp(`<title>[^<]*${name}`))
      expect(html).toContain('Blogs about walking a city.')
      expect(html).toContain('id="tela-data"')
      expect(html).toContain(`href="${next}"`)
      // Private: no page at the edge, and no answer from tela-api.
      expect((await guest.get(`/l/${hidden}`)).status()).toBe(404)
      expect((await guest.get(`/api/v1/public/blogrolls/${hidden}`)).status()).toBe(404)
    } finally {
      await guest.dispose()
    }

    // Without a script, as the edge sent it: every action is a link to sign in and come back.
    const context = await browser.newContext({ baseURL: BASE, javaScriptEnabled: false })
    try {
      const visitor = await context.newPage()
      await visitor.goto(`/l/${id}`)
      const view = visitor.getByTestId('blogroll-page')
      await expect(view.getByRole('heading', { level: 1 })).toHaveText(name)
      await expect(view.getByTestId('blogroll-subscribe-all')).toHaveAttribute('href', next)
      const rows = view.getByTestId('blogroll-row')
      await expect(rows).toHaveCount(3)
      for (const row of await rows.all()) {
        await expect(row.getByTestId('blogroll-row-subscribe')).toHaveAttribute('href', next)
      }
      // By feed, not by name: the fixture feeds share one blog, whose description (胡涂说博客…) every
      // row shows as its tagline.
      await expect(
        view.locator(`[data-testid="blogroll-row"][data-feed-id="${feeds.hutusi}"]`),
      ).toContainText(NOTE)
      // A listed blog links to its page on Tela, any other to the blog itself.
      const answer = await publicBlogroll(id)
      expect(answer?.blogs).toHaveLength(3)
      for (const blog of answer?.blogs ?? []) {
        const href = blog.listed ? `/s/${blog.siteId}` : blog.homeUrl
        await expect(
          rows
            .filter({ hasText: blog.name ?? '' })
            .locator(`a[href="${href}"]`)
            .first(),
        ).toBeVisible()
      }
    } finally {
      await context.close()
    }
  })
})

test.describe('profiles, Discover and the console', () => {
  test("a visitor sees a profile's Blogrolls tab only for a public blogroll; its owner always does", async ({
    browser,
    page,
  }) => {
    const quiet = await member(browser, { reads: [] })
    const kept = `Kept to myself ${RUN}`
    await blogroll(quiet.page, [quiet.feeds.jvns], { name: kept })
    const open = await member(browser, { reads: [] })
    const name = `Shared shelf ${RUN}`
    const id = await blogroll(open.page, [open.feeds.jvns, open.feeds.jnito], {
      name,
      isPublic: true,
    })

    // `page` is a visitor's: no cookie.
    await page.goto(`/@${quiet.handle}`)
    await expect(page.getByTestId('profile-tab-recommendations')).toBeVisible()
    await expect(page.getByTestId('profile-tab-blogrolls')).toHaveCount(0)

    await page.goto(`/@${open.handle}`)
    await page.getByTestId('profile-tab-blogrolls').click()
    await expect(page).toHaveURL(/[?&]tab=blogrolls/)
    const card = page
      .getByTestId('profile-blogrolls')
      .getByTestId('blogroll-card')
      .filter({ hasText: name })
    await expect(card).toBeVisible()
    await expect(card).toContainText(JVNS)
    await expect(card).not.toContainText('Private')
    await card.click()
    await expect(page).toHaveURL(new RegExp(`/l/${id}$`))
    await expect(page.getByTestId('blogroll-page').getByRole('heading', { level: 1 })).toHaveText(
      name,
    )

    // Its owner has the tab with nothing public: their private blogroll, marked, and New blogroll.
    await quiet.page.goto(`/@${quiet.handle}`)
    await quiet.page.getByTestId('profile-tab-blogrolls').click()
    const own = quiet.page.getByTestId('blogroll-card').filter({ hasText: kept })
    await expect(own).toContainText('Private')
    await expect(quiet.page.getByTestId('new-blogroll')).toBeVisible()
  })

  test('Discover lists a public blogroll of three blogs, and not one of two', async ({
    browser,
    page,
  }) => {
    const { page: mine, feeds } = await member(browser, { reads: [] })
    const three = `Three to start ${RUN}`
    const two = `Two is too few ${RUN}`
    const id = await blogroll(mine, [feeds.jvns, feeds.jnito, feeds.hutusi], {
      name: three,
      isPublic: true,
    })
    const fewer = await blogroll(mine, [feeds.jvns, feeds.jnito], { name: two, isPublic: true })
    const listed = await inDiscover()
    expect(listed).toContain(id)
    expect(listed).not.toContain(fewer)

    // `page` is a visitor's: the tab is a link, the fifth.
    await page.goto('/discover')
    await expect(page.getByTestId('discover-tabs').getByRole('link')).toHaveCount(5)
    await page.getByTestId('discover-tab-blogrolls').click()
    await expect(page).toHaveURL(/\/discover\/blogrolls$/)
    await expect(page.getByTestId('discover-tab-blogrolls')).toHaveAttribute('aria-current', 'page')
    const card = page.getByTestId('blogroll-card').filter({ hasText: three })
    await expect(card).toBeVisible()
    await expect(card).toContainText(HUTUSI)
    await expect(page.getByTestId('blogroll-card').filter({ hasText: two })).toHaveCount(0)
    // Fewer than a page's worth: no More.
    await expect(page.getByTestId('blogrolls-more')).toHaveCount(0)
    await card.click()
    await expect(page).toHaveURL(new RegExp(`/l/${id}$`))
  })

  test('the operator hides a blogroll from Discover and restores it; its page and profile keep it', async ({
    browser,
  }) => {
    const owner = await member(browser, { reads: [] })
    const name = `Hide me ${RUN}`
    const id = await blogroll(
      owner.page,
      [owner.feeds.jvns, owner.feeds.jnito, owner.feeds.hutusi],
      { name, isPublic: true },
    )
    expect(await inDiscover()).toContain(id)
    const { page } = await member(browser, { reads: [], admin: true })
    await page.goto('/admin/discover?f=blogrolls')
    await expect(
      page.locator('[data-testid="admin-filter"][data-filter="blogrolls"]'),
    ).toHaveAttribute('aria-pressed', 'true')
    const row = page.locator(`[data-testid="admin-row"][data-row-id="${id}"]`)
    await expect(row).toContainText(name)
    await expect(row).toContainText(owner.handle)
    await expect(row).toContainText('In Discover')
    await row.click()
    const record = page.getByTestId('admin-record')
    await record.locator('[data-testid="admin-record-action"][data-action="blogroll.hide"]').click()
    await expect(page.getByTestId('admin-toast')).toContainText('Hidden')
    await expect(row).toContainText('Hidden')
    expect(await inDiscover()).not.toContain(id)
    // Hidden from Discover only: its page and its place on the profile stay, and its owner's own
    // copy says nothing of it (it never syncs).
    expect((await publicBlogroll(id))?.blogroll.name).toBe(name)
    expect(await onProfile(owner.handle)).toContain(id)
    expect(
      (await onServer(owner.page.request)).blogrolls.find((b) => b.id === id),
    ).not.toHaveProperty('hiddenAt')

    if (!(await record.isVisible())) await row.click()
    await record
      .locator('[data-testid="admin-record-action"][data-action="blogroll.restore"]')
      .click()
    await expect(row).toContainText('In Discover')
    expect(await inDiscover()).toContain(id)
  })
})

test.describe('blogrolls on a phone', () => {
  test("at 390px: Make a blogroll… from a folder's ···, and the dialog, Add blogs and Subscribe to all as sheets", async ({
    browser,
  }) => {
    const owner = await member(browser, { width: 390 })
    const folderId = `e2e-roll-phone-${RUN}`
    await push(owner.page, [
      { type: 'putFolder', id: folderId, name: 'Walks' },
      { type: 'fileFeed', feedId: owner.feeds.jvns, folderId },
      { type: 'fileFeed', feedId: owner.feeds.jnito, folderId },
    ])
    await owner.page.goto('/settings/subscriptions')
    await settingsGroup(owner.page, 'Walks').getByTestId('folder-more').click()
    await owner.page.getByTestId('folder-make-blogroll').click()
    const sheet = owner.page
      .getByRole('dialog')
      .filter({ has: owner.page.getByTestId('blogroll-dialog-name') })
    await expect(sheet).toBeVisible()
    await expect(sheet.getByTestId('blogroll-dialog-name')).toHaveValue('Walks')
    await noSidewaysScroll(owner.page, 'the New blogroll sheet')
    await sheet.getByTestId('blogroll-dialog-submit').click()
    const id = await blogrollId(owner.page)
    const rows = owner.page.getByTestId('blogroll-row')
    await expect(rows).toHaveCount(2)
    await noSidewaysScroll(owner.page, "the owner's blogroll")

    // Add blogs is a sheet below md.
    await owner.page.getByTestId('blogroll-add-blogs').click()
    const add = owner.page
      .getByRole('dialog')
      .filter({ has: owner.page.getByTestId('add-blogs-filter') })
    await expect(add).toBeVisible()
    const hutusi = add.getByTestId('add-blogs-item').filter({ hasText: HUTUSI })
    await hutusi.click()
    await expect(hutusi).toBeChecked()
    await noSidewaysScroll(owner.page, 'the Add blogs sheet')
    await owner.page.keyboard.press('Escape')
    await expect(add).toHaveCount(0)
    await expect(rows).toHaveCount(3)
    await owner.page.getByTestId('blogroll-public-toggle').click()
    await expect.poll(() => isPublicOnServer(owner.page, id), { timeout: 15_000 }).toBe(true)

    // Someone else's Subscribe to all is a sheet too.
    const visitor = await member(browser, { reads: [], width: 390 })
    await visitor.page.goto(`/l/${id}`)
    await visitor.page.getByTestId('blogroll-subscribe-all').click()
    const subscribe = visitor.page
      .getByRole('dialog')
      .filter({ has: visitor.page.getByTestId('subscribe-all-submit') })
    await expect(subscribe).toBeVisible()
    await expect(subscribe.getByTestId('subscribe-all-submit')).toHaveText(
      /Subscribe to (all )?3\b/,
    )
    await noSidewaysScroll(visitor.page, 'the Subscribe to all sheet')
    await visitor.page.keyboard.press('Escape')
    await expect(subscribe).toHaveCount(0)
  })

  test('at 320px: a long name, a Chinese one, the profile tab and Discover’s five tabs keep to the screen', async ({
    browser,
  }) => {
    const { page, feeds, handle } = await member(browser, { reads: [], width: 320 })
    // Sixty characters and no space to break at.
    const long = `${'Kilometrocero'.repeat(5).slice(0, 55)}${RUN}`
    const chinese = `我在周日早上读的那些写城市散步的独立博客${RUN}`
    const id = await blogroll(page, [feeds.jvns, feeds.jnito, feeds.hutusi], {
      name: long,
      description: 'Des blogs que je lis le dimanche matin, au café du coin de la rue.',
      isPublic: true,
      notes: [[feeds.jvns, NOTE]],
    })
    const zh = await blogroll(page, [feeds.hutusi], { name: chinese, isPublic: true })

    for (const [blogrollIdOf, title] of [
      [id, long],
      [zh, chinese],
    ] as const) {
      await page.goto(`/l/${blogrollIdOf}`)
      await expect(page.getByTestId('blogroll-page').getByRole('heading', { level: 1 })).toHaveText(
        title,
      )
      await noSidewaysScroll(page, `the blogroll ${title}`)
    }

    await page.goto(`/@${handle}`)
    await page.getByTestId('profile-tab-blogrolls').click()
    await expect(page.getByTestId('blogroll-card')).toHaveCount(2)
    await noSidewaysScroll(page, "the profile's Blogrolls tab")

    // Five tabs do not fit 320px: the row scrolls, and the page does not.
    await page.goto('/discover')
    const tab = page.getByTestId('discover-tab-blogrolls')
    await tab.scrollIntoViewIfNeeded()
    await tab.click()
    await expect(tab).toHaveAttribute('aria-current', 'page')
    await expect(tab).toBeInViewport()
    expect(
      await page.getByTestId('discover-tabs').evaluate((el) => el.scrollWidth > el.clientWidth),
    ).toBe(true)
    await expect(page.getByTestId('blogroll-card').filter({ hasText: long })).toBeVisible()
    await noSidewaysScroll(page, "Discover's Blogrolls tab")
  })
})

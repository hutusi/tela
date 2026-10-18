/**
 * Folders (ADRs 0048, 0049):
 * - in the sidebar a folder opens and closes on this device, and its name reads every blog in it
 *   as one list, with the Unread/All switch, Mark all read and its Undo;
 * - a folder deleted elsewhere is gone, not a redirect;
 * - Settings › Subscriptions from `lg` up is the manager: folders made, renamed and deleted in its
 *   pane, blogs moved by menu and by dragging, several at once in Select mode, filtered and
 *   sorted, each change with its Undo; below `lg` it is the sections, moved by a sheet;
 * - OPML carries them both ways.
 *
 * Each test signs in a member of its own, from an address of its own (sign-in is limited per IP
 * and per address), so the shared member's sidebar stays flat for every other spec. Each leaves
 * the fixture blogs again when it ends, passed or not: they are one site, and other specs count
 * its readers (from three, a count is published, ADR 0041).
 */
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { type APIRequestContext, type Browser, expect, type Page, test } from '@playwright/test'
import {
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
/** The fixture blogs each member follows, by the name the sidebar gives them. */
const JVNS = 'Julia Evans'
const JNITO = 'give IT a try'
const HUTUSI = '胡涂说'

let members = 0
/** What each test's members must undo when it ends. */
const leave: (() => Promise<void>)[] = []
test.afterEach(async () => {
  for (const undo of leave.splice(0)) await undo()
})

/** A new member following the three fixture blogs, on a page of their own; their feed ids. */
async function member(
  browser: Browser,
  options: { width?: number } = {},
): Promise<{ page: Page; feeds: { jvns: number; jnito: number; hutusi: number } }> {
  const n = ++members
  const context = await browser.newContext({
    baseURL: BASE,
    extraHTTPHeaders: { 'cf-connecting-ip': `192.0.2.${200 + n}` },
    ...(options.width ? { viewport: { width: options.width, height: 860 } } : {}),
  })
  await signInRequest(context.request, `folders-${n}-${Date.now()}@e2e.test`)
  const feed = async (path: string) => (await addFeed(context.request, `${FIXTURES}${path}`)).feedId
  const feeds = {
    jvns: await feed('/jvns.xml'),
    jnito: await feed('/jnito.xml'),
    hutusi: await feed('/hutusi.xml'),
  }
  leave.push(async () => {
    await push(
      context.request,
      Object.values(feeds).map((feedId) => ({ type: 'unsubscribe', feedId })),
    )
    await context.close()
  })
  await cycle(context.request)
  return { page: await context.newPage(), feeds }
}

/** Changes made as another device makes them: straight to tela-api. */
async function push(
  to: Page | APIRequestContext,
  mutations: Record<string, unknown>[],
): Promise<void> {
  const request = 'request' in to ? to.request : to
  const at = Date.now()
  const res = await request.post(`${BASE}/api/v1/mutations`, {
    headers: { ...ORIGIN, ...(await memberHeaders(request)) },
    data: { mutations: mutations.map((m) => ({ mid: crypto.randomUUID(), at, ...m })) },
  })
  expect(res.ok()).toBe(true)
}

/** The sidebar's blog names in the order it shows them. */
const sidebarBlogs = (page: Page) =>
  page.getByTestId('sidebar').getByTestId('subscription').locator('span.truncate').allTextContents()

test.describe('folders in the sidebar', () => {
  test('a folder holds its blogs, opens and closes on this device, and reads as one list', async ({
    browser,
  }) => {
    const { page, feeds } = await member(browser)
    await push(page, [
      { type: 'putFolder', id: 'e2e-folder-tech', name: 'Tech' },
      { type: 'fileFeed', feedId: feeds.jvns, folderId: 'e2e-folder-tech' },
      { type: 'fileFeed', feedId: feeds.jnito, folderId: 'e2e-folder-tech' },
      { type: 'setPref', key: 'reader.hide_read', value: false },
    ])
    await page.goto('/reading')
    const folder = page.getByTestId('folder').filter({ hasText: 'Tech' })
    await expect(folder).toBeVisible()
    // The folder's blogs by title under it, then the blog in none.
    await expect.poll(() => sidebarBlogs(page)).toEqual([JNITO, JVNS, HUTUSI])

    const toggle = folder.getByTestId('folder-toggle')
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
    await expect(toggle).toHaveAccessibleName('Collapse Tech')
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await expect(toggle).toHaveAccessibleName('Expand Tech')
    await expect.poll(() => sidebarBlogs(page)).toEqual([HUTUSI])
    // This device's to keep: closed after a reload too.
    await page.reload()
    await expect(page.getByTestId('folder-toggle')).toHaveAttribute('aria-expanded', 'false')
    await expect.poll(() => sidebarBlogs(page)).toEqual([HUTUSI])
    await page.getByTestId('folder-toggle').click()
    await expect.poll(() => sidebarBlogs(page)).toEqual([JNITO, JVNS, HUTUSI])

    // The name reads the folder: its title, its blogs named under it, and only their posts.
    const countOf = async (href: string) => {
      await page.goto(href)
      await expect(page.getByTestId('article-row').first()).toBeVisible()
      return page.getByTestId('article-row').count()
    }
    const jvnsPosts = await countOf(`/reading?feed=${feeds.jvns}`)
    const jnitoPosts = await countOf(`/reading?feed=${feeds.jnito}`)
    await page.goto('/reading')
    await page.getByTestId('folder-link').click()
    await expect(page).toHaveURL(/[?&]folder=e2e-folder-tech/)
    await expect(page.getByTestId('folder-link')).toHaveAttribute('aria-current', 'page')
    await expect(page.locator('[data-list-head] h1')).toHaveText('Tech')
    await expect(page.getByTestId('list-subtitle')).toHaveText(`${JNITO}, ${JVNS}`)
    await expect(page.getByTestId('list-show-all')).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByTestId('article-row')).toHaveCount(jvnsPosts + jnitoPosts)

    // j and k stay in the folder.
    await page.keyboard.press('j')
    await expect(page).toHaveURL(
      /folder=e2e-folder-tech.*article=\d+|article=\d+.*folder=e2e-folder-tech/,
    )
  })

  test("Mark all read on a folder reads only its blogs' posts, and Undo takes it all back", async ({
    browser,
  }) => {
    const { page, feeds } = await member(browser)
    await push(page, [
      { type: 'putFolder', id: 'e2e-folder-mark', name: 'Reading pile' },
      { type: 'fileFeed', feedId: feeds.jvns, folderId: 'e2e-folder-mark' },
      { type: 'fileFeed', feedId: feeds.jnito, folderId: 'e2e-folder-mark' },
      { type: 'setPref', key: 'reader.hide_read', value: false },
    ])
    const pushed: string[] = []
    page.on('request', (r) => {
      if (r.url().includes('/api/v1/mutations')) pushed.push(r.postData() ?? '')
    })
    // The toast's time is the page's clock, so the spec says when it is up.
    await page.clock.install()
    await page.goto('/reading?folder=e2e-folder-mark')
    const folderCount = page.getByTestId('folder-link').locator('span').last()
    const outside = page
      .getByTestId('subscription')
      .filter({ hasText: HUTUSI })
      .locator('span')
      .last()
    await expect(page.getByTestId('unread-dot').first()).toBeVisible()
    const unread = Number(await folderCount.textContent())
    const elsewhere = await outside.textContent()
    expect(unread).toBeGreaterThan(0)

    await page.getByTestId('mark-all-read').click()
    await expect(page.getByTestId('unread-dot')).toHaveCount(0)
    await expect(folderCount).toHaveText('')
    // A blog outside the folder keeps its count.
    await expect(outside).toHaveText(elsewhere ?? '')
    const toast = page.getByTestId('toast')
    await expect(toast).toContainText(`Marked ${unread} posts read.`)
    await toast.getByTestId('toast-action').click()
    await expect(folderCount).toHaveText(String(unread))
    await expect(page.getByTestId('unread-dot')).toHaveCount(unread)
    // Held while the toast showed, so nothing was sent.
    await page.reload()
    await expect(page.getByTestId('unread-dot').first()).toBeVisible()
    expect(pushed.filter((body) => body.includes('"markAllRead"'))).toEqual([])

    // Marked again and left alone: once the toast has gone, one mark for each blog in the folder,
    // sent together.
    await page.getByTestId('mark-all-read').click()
    await expect(folderCount).toHaveText('')
    const sent = page.waitForRequest((r) => (r.postData() ?? '').includes('"markAllRead"'))
    await page.clock.runFor(6000)
    const body = JSON.parse((await sent).postData() ?? '{}') as {
      mutations: { type: string; feedId?: number }[]
    }
    const marks = body.mutations.filter((m) => m.type === 'markAllRead')
    expect(marks.map((m) => m.feedId).sort()).toEqual([feeds.jvns, feeds.jnito].sort())
  })

  test('a folder deleted on another device is gone, and its blogs are in none', async ({
    browser,
  }) => {
    const { page, feeds } = await member(browser)
    await push(page, [
      { type: 'putFolder', id: 'e2e-folder-gone', name: 'Soon gone' },
      { type: 'fileFeed', feedId: feeds.jvns, folderId: 'e2e-folder-gone' },
    ])
    await page.goto('/reading?folder=e2e-folder-gone')
    await expect(page.locator('[data-list-head] h1')).toHaveText('Soon gone')
    await push(page, [{ type: 'deleteFolder', id: 'e2e-folder-gone' }])
    // The next pull (a focus, or the minute's) brings the deletion; a reload is the quickest.
    await page.reload()
    await expect(page.getByTestId('folder-gone')).toBeVisible()
    await expect(page).toHaveURL(/folder=e2e-folder-gone/)
    await expect(page.getByTestId('folder')).toHaveCount(0)
    await expect.poll(() => sidebarBlogs(page)).toEqual([JNITO, JVNS, HUTUSI])
  })
})

/** A blog's row in Settings › Subscriptions. */
const settingsRow = (page: Page, blog: string) =>
  page.getByTestId('settings-subscription').filter({ hasText: blog })
/** A folder's section in Settings › Subscriptions below `lg`, by its name. */
const settingsGroup = (page: Page, name: string) =>
  page.getByTestId('folder-group').filter({ has: page.getByRole('heading', { name, exact: true }) })
/** A place in the manager's pane, from `lg` up: a folder's by its name. */
const place = (page: Page, name: string) =>
  page.getByTestId('subscriptions-manager').getByTestId('place').filter({ hasText: name })
/** The count a place in the pane shows. */
const placeCount = (page: Page, name: string) => place(page, name).locator('span').last()

/** What tela-api holds of the member's folders, through a snapshot pull. */
async function foldersOnServer(page: Page) {
  const res = await page.request.get(`${BASE}/api/v1/sync?cursor=0`, {
    headers: await memberHeaders(page.request),
  })
  expect(res.ok()).toBe(true)
  const { rows } = (await res.json()) as {
    rows: {
      folders: { id: string; name: string }[]
      feedFolders: { feedId: number; folderId: string | null }[]
      subscriptions: { feedId: number; deletedAt: number | null }[]
    }
  }
  return rows
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

test.describe('Settings › Subscriptions, the manager from lg up', () => {
  test('New folder, a move by its menu and by dragging, each with Undo, Rename, and a delete', async ({
    browser,
  }) => {
    const { page, feeds } = await member(browser)
    const sent = pushes(page)
    await page.goto('/settings/subscriptions')
    const manager = page.getByTestId('subscriptions-manager')
    await expect(manager.getByTestId('settings-subscription')).toHaveCount(3)
    await expect(page.getByTestId('manager-title')).toHaveText('All blogs')
    await expect(placeCount(page, 'All blogs')).toHaveText('3')
    await expect(placeCount(page, 'Not in a folder')).toHaveText('3')

    await page.getByTestId('new-folder').click()
    await page.getByTestId('new-folder-input').fill('  Tech ')
    await page.keyboard.press('Enter')
    await expect(placeCount(page, 'Tech')).toHaveText('0')
    await expect(place(page, 'Tech')).toBeFocused()
    await expect(page.getByTestId('toast')).toContainText('Created Tech. Drag blogs onto it.')
    await expect(page.getByTestId('subscription-count')).toHaveText('3 blogs in 1 folder.')
    // A name the member has, case aside, is refused.
    await page.getByTestId('new-folder').click()
    await page.getByTestId('new-folder-input').fill('tech')
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('new-folder-error')).toHaveText(
      'You already have a folder called Tech.',
    )
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('new-folder-input')).toHaveCount(0)
    await expect(page.getByTestId('new-folder')).toBeFocused()

    // By the row's folder button, and taken back while its toast shows: nothing was sent.
    const chip = settingsRow(page, JVNS).getByTestId('move-to')
    await chip.click()
    const menu = page.getByTestId('move-to-menu')
    await expect(
      menu.getByTestId('move-to-option').filter({ hasText: 'No folder' }),
    ).toHaveAttribute('aria-checked', 'true')
    await menu.getByTestId('move-to-option').filter({ hasText: 'Tech' }).click()
    await expect(chip).toHaveText('Tech')
    await expect(chip).toBeFocused()
    const toast = page.getByTestId('toast')
    await expect(toast).toContainText(`Moved ${JVNS} to Tech.`)
    await toast.getByTestId('toast-action').click()
    await expect(chip).toHaveText('No folder')
    expect(sent).not.toContain('fileFeed')
    await chip.click()
    await menu.getByTestId('move-to-option').filter({ hasText: 'Tech' }).click()
    await expect(placeCount(page, 'Tech')).toHaveText('1')

    // By dragging the row onto the folder in the pane.
    await settingsRow(page, JNITO).dragTo(place(page, 'Tech'))
    await expect(placeCount(page, 'Tech')).toHaveText('2')
    await expect(toast).toContainText(`Moved ${JNITO} to Tech.`)
    // Let go once their toasts go, both moves reach tela-api.
    await expect
      .poll(
        async () => (await foldersOnServer(page)).feedFolders.filter((f) => f.folderId).length,
        {
          timeout: 15_000,
        },
      )
      .toBe(2)

    // The sidebar has it.
    await page.goto('/reading')
    await expect(page.getByTestId('folder')).toHaveText(/Tech/)
    await expect.poll(() => sidebarBlogs(page)).toEqual([JNITO, JVNS, HUTUSI])

    await page.goto('/settings/subscriptions')
    await place(page, 'Tech').click()
    await expect(page.getByTestId('manager-title')).toHaveText('Tech')
    await expect(page.getByTestId('manager-count')).toHaveText('2 blogs')
    await page.getByTestId('folder-rename').click()
    await page.getByTestId('folder-rename-input').fill('Code')
    await page.getByTestId('folder-rename-save').click()
    await expect(page.getByTestId('manager-title')).toHaveText('Code')
    await expect(page.getByTestId('folder-rename')).toBeFocused()

    // Deleted, its blogs are in none, and that is where the manager looks; taken back while its
    // toast shows, the folder and its blogs are as they were.
    await page.getByTestId('folder-delete').click()
    await expect(page.getByTestId('manager-title')).toHaveText('Not in a folder')
    await expect(place(page, 'Not in a folder')).toBeFocused()
    await expect(place(page, 'Code')).toHaveCount(0)
    await expect(toast).toContainText('Deleted Code. Its blogs are no longer in a folder.')
    await toast.getByTestId('toast-action').click()
    await expect(placeCount(page, 'Code')).toHaveText('2')
    // Deleted for good: the blogs are in none, here and on tela-api.
    await place(page, 'Code').click()
    await page.getByTestId('folder-delete').click()
    await expect(toast).toHaveCount(0, { timeout: 10_000 })
    await expect.poll(async () => (await foldersOnServer(page)).folders).toEqual([])
    const filed = (await foldersOnServer(page)).feedFolders
    expect(filed.filter((f) => f.folderId !== null)).toEqual([])
    expect(filed.map((f) => f.feedId).sort()).toEqual([feeds.jnito, feeds.jvns].sort())
  })

  test('Select: a run by Shift-click, a bulk move and its Undo, New folder with these, and Esc', async ({
    browser,
  }) => {
    const { page } = await member(browser)
    await push(page, [{ type: 'putFolder', id: 'e2e-folder-pile', name: 'Reading pile' }])
    await page.goto('/settings/subscriptions')
    const rows = page.getByTestId('subscriptions-manager').getByTestId('settings-subscription')
    await expect(rows).toHaveCount(3)
    // Out of Select mode a click on a row is no tick, and there are no boxes.
    await expect(page.getByTestId('subscription-tick')).toHaveCount(0)
    const select = page.getByTestId('select-toggle')
    await expect(select).toHaveAttribute('aria-pressed', 'false')
    await select.click()
    await expect(select).toHaveAttribute('aria-pressed', 'true')
    await expect(select).toHaveText('Done')
    await expect(page.getByTestId('subscription-tick')).toHaveCount(3)

    // A click ticks; Shift ticks the run from it.
    await settingsRow(page, JNITO).click()
    await settingsRow(page, HUTUSI).click({ modifiers: ['Shift'] })
    await expect(page.getByTestId('bulk-count')).toHaveText('3 selected')
    await expect(page.getByTestId('select-all')).toBeChecked()
    await settingsRow(page, JVNS).getByTestId('subscription-tick').click()
    await expect(page.getByTestId('bulk-count')).toHaveText('2 selected')
    expect(
      await page.getByTestId('select-all').evaluate((el) => (el as HTMLInputElement).indeterminate),
    ).toBe(true)
    // A tick the filter hides still counts, and the bar says so.
    const filter = page.getByTestId('subscriptions-filter')
    await filter.fill('give it')
    await expect(rows).toHaveCount(1)
    await expect(page.getByTestId('manager-count')).toHaveText('1 of 3')
    await expect(page.getByTestId('bulk-count')).toHaveText('2 selected, 1 hidden by the filter')
    // Esc in the filter clears it, and leaves Select mode alone.
    await filter.press('Escape')
    await expect(filter).toHaveValue('')
    await expect(rows).toHaveCount(3)
    await expect(select).toHaveAttribute('aria-pressed', 'true')

    // Both, in one move, taken back as one.
    await page.getByTestId('bulk-move').click()
    await page.getByTestId('move-to-option').filter({ hasText: 'Reading pile' }).click()
    await expect(placeCount(page, 'Reading pile')).toHaveText('2')
    await expect(page.getByTestId('bulk-bar')).toHaveCount(0)
    await expect(page.getByTestId('select-all')).toBeFocused()
    const toast = page.getByTestId('toast')
    await expect(toast).toContainText('Moved 2 blogs to Reading pile.')
    await toast.getByTestId('toast-action').click()
    await expect(placeCount(page, 'Reading pile')).toHaveText('0')

    // A new folder with the blog ticked in it, opened.
    await settingsRow(page, JVNS).click()
    await page.getByTestId('bulk-move').click()
    await page.getByTestId('bulk-new-folder').click()
    await expect(page.getByText('New folder with 1 blog')).toBeVisible()
    await page.getByTestId('new-folder-input').fill('Solo')
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('manager-title')).toHaveText('Solo')
    await expect(rows).toHaveText([new RegExp(JVNS)])
    await expect(toast).toContainText('Created Solo with 1 blog.')

    // Esc leaves Select mode, and takes the ticks with it.
    await rows.first().click()
    await expect(page.getByTestId('bulk-count')).toHaveText('1 selected')
    await page.keyboard.press('Escape')
    await expect(select).toHaveAttribute('aria-pressed', 'false')
    await expect(page.getByTestId('subscription-tick')).toHaveCount(0)
  })

  test('several blogs left at once go together, and Undo brings them all back unsent', async ({
    browser,
  }) => {
    const { page, feeds } = await member(browser)
    const sent = pushes(page)
    await page.goto('/settings/subscriptions')
    const rows = page.getByTestId('subscriptions-manager').getByTestId('settings-subscription')
    await expect(rows).toHaveCount(3)
    await page.getByTestId('select-toggle').click()
    await settingsRow(page, JNITO).click()
    await settingsRow(page, HUTUSI).click()
    await page.getByTestId('bulk-unsubscribe').click()
    await expect(rows).toHaveText([new RegExp(JVNS)])
    await expect(page.getByTestId('subscription-count')).toHaveText(/^1 blog\./)
    const toast = page.getByTestId('toast')
    await expect(toast).toContainText('Unsubscribed from 2 blogs.')
    await toast.getByTestId('toast-action').click()
    await expect(rows).toHaveCount(3)
    expect(sent).not.toContain('unsubscribe')

    // One by its folder button's menu, left alone: it goes to tela-api once the toast does.
    await page.getByTestId('select-toggle').click()
    await settingsRow(page, HUTUSI).getByTestId('move-to').click()
    await page.getByTestId('row-unsubscribe').click()
    await expect(rows).toHaveCount(2)
    await expect(toast).toContainText(`Unsubscribed from ${HUTUSI}.`)
    // A snapshot holds only the blogs followed.
    await expect
      .poll(
        async () =>
          (await foldersOnServer(page)).subscriptions.some(
            (s) => s.feedId === feeds.hutusi && s.deletedAt === null,
          ),
        { timeout: 15_000 },
      )
      .toBe(false)
  })

  test('the filter ignores accents and case, and the sort puts the quietest first', async ({
    browser,
  }) => {
    const { page } = await member(browser)
    await page.goto('/settings/subscriptions')
    const rows = page.getByTestId('subscriptions-manager').getByTestId('settings-subscription')
    await expect(rows).toHaveCount(3)
    const names = () => rows.locator('.font-medium').allTextContents()
    expect(await names()).toEqual([JNITO, JVNS, HUTUSI])
    // Every row says when its blog last posted.
    for (const latest of await page.getByTestId('latest-post').allTextContents()) {
      expect(latest).toMatch(/ago|Yesterday|Today|Last/)
    }
    await page.getByTestId('subscriptions-filter').fill('JÚLIA')
    await expect(rows).toHaveText([new RegExp(JVNS)])
    // By address: the feed's own.
    await page.getByTestId('subscriptions-filter').fill('hutusi.xml')
    await expect(rows).toHaveText([new RegExp(HUTUSI)])
    await page.getByTestId('subscriptions-filter').fill('nothing like it')
    await expect(page.getByTestId('manager-empty')).toHaveText(
      'No blogs here match “nothing like it”.',
    )
    await page.getByTestId('subscriptions-filter').fill('')

    await page.getByTestId('subscriptions-sort').click()
    await page.getByTestId('sort-option').filter({ hasText: 'Quiet longest' }).click()
    await expect(page.getByTestId('subscriptions-sort')).toHaveText('Quiet longest')
    const quiet = await names()
    await page.getByTestId('subscriptions-sort').click()
    await page.getByTestId('sort-option').filter({ hasText: 'Recently posted' }).click()
    await expect.poll(names).toEqual([...quiet].reverse())
  })

  test('OPML: an import makes the folders it names, and an export holds them', async ({
    browser,
  }) => {
    const { page } = await member(browser)
    await page.goto('/settings/subscriptions')
    await expect(page.getByTestId('settings-subscription')).toHaveCount(3)
    // The fixture file lists two of the member's blogs under "Tech".
    await page
      .getByTestId('opml-file')
      .setInputFiles(resolve(import.meta.dirname, 'fixtures/subs.opml'))
    await expect(placeCount(page, 'Tech')).toHaveText('2')
    await expect(settingsRow(page, JVNS).getByTestId('move-to')).toHaveText('Tech')
    await expect(settingsRow(page, HUTUSI).getByTestId('move-to')).toHaveText('No folder')

    const saved = page.waitForEvent('download')
    await page.getByTestId('opml-export').click()
    const opml = await readFile(await (await saved).path(), 'utf8')
    const folder = opml.match(/<outline text="Tech"[^>]*>([\s\S]*?)<\/outline>/)?.[1] ?? ''
    expect(folder).toContain(`${FIXTURES}/jvns.xml`)
    expect(folder).toContain(`${FIXTURES}/jnito.xml`)
    expect(folder).not.toContain(`${FIXTURES}/hutusi.xml`)
    expect(opml).toContain(`${FIXTURES}/hutusi.xml`)
  })

  test('the manager from 1024px, the sections below it, and neither scrolls sideways', async ({
    browser,
  }) => {
    const { page, feeds } = await member(browser, { width: 1023 })
    await push(page, [
      { type: 'setProfile', uiLocale: 'fr' },
      { type: 'putFolder', id: 'e2e-folder-width', name: 'Des blogs que je lis le dimanche matin' },
      { type: 'fileFeed', feedId: feeds.jnito, folderId: 'e2e-folder-width' },
    ])
    await page.context().addCookies([{ name: 'tela_locale', value: 'fr', url: BASE }])
    await page.goto('/settings/subscriptions')
    await expect(page.getByTestId('folder-group')).toHaveCount(2)
    await expect(page.getByTestId('subscriptions-manager')).toHaveCount(0)
    // Not a phone: Settings' side column, so New folder is in the page, and Move to a sheet.
    await expect(page.getByTestId('settings-nav')).toBeVisible()
    await expect(page.getByTestId('settings-back-bar')).toHaveCount(0)
    await expect(page.getByTestId('new-folder')).toBeVisible()
    await noSidewaysScroll(page, 'Settings › Subscriptions at 1023px')
    await settingsRow(page, HUTUSI).getByTestId('move-to').click()
    await expect(page.getByTestId('move-sheet')).toBeVisible()
    await page.keyboard.press('Escape')

    await page.setViewportSize({ width: 1024, height: 860 })
    await expect(page.getByTestId('subscriptions-manager')).toBeVisible()
    await expect(page.getByTestId('folder-group')).toHaveCount(0)
    await place(page, 'Des blogs').click()
    await page.getByTestId('select-toggle').click()
    await noSidewaysScroll(page, 'the manager at 1024px')
    // The longest bar of the four languages still fits its row.
    await settingsRow(page, JNITO).click()
    const bar = await page.getByTestId('bulk-bar').boundingBox()
    const card = await page.getByTestId('subscriptions-manager').boundingBox()
    expect((bar?.x ?? 0) + (bar?.width ?? 0)).toBeLessThanOrEqual(
      (card?.x ?? 0) + (card?.width ?? 0),
    )
  })
})

test.describe('folders on a phone', () => {
  test('the Feeds menu holds them, and a blog moves by the sheet', async ({ browser }) => {
    const { page, feeds } = await member(browser, { width: 390 })
    await push(page, [
      { type: 'putFolder', id: 'e2e-folder-phone', name: 'Cities' },
      { type: 'fileFeed', feedId: feeds.jvns, folderId: 'e2e-folder-phone' },
    ])
    await page.goto('/reading')
    await page.getByTestId('mobile-nav').locator('summary').click()
    const folder = page.getByTestId('mobile-folder')
    await expect(folder).toContainText('Cities')
    const chevron = await folder.getByTestId('mobile-folder-toggle').boundingBox()
    expect(chevron?.width).toBeGreaterThanOrEqual(44)
    expect(chevron?.height).toBeGreaterThanOrEqual(44)
    await expect(page.getByTestId('mobile-subscription').filter({ hasText: JVNS })).toBeVisible()
    await folder.getByTestId('mobile-folder-toggle').click()
    await expect(page.getByTestId('mobile-subscription').filter({ hasText: JVNS })).toHaveCount(0)
    await folder.getByTestId('mobile-folder-link').click()
    await expect(page).toHaveURL(/folder=e2e-folder-phone/)
    await expect(page.getByTestId('list-subtitle')).toHaveText(JVNS)

    await page.goto('/settings/subscriptions')
    await expect(page.getByTestId('drag-grip')).toHaveCount(0)
    await settingsRow(page, HUTUSI).getByTestId('move-to').click()
    const sheet = page.getByTestId('move-sheet')
    await expect(sheet).toContainText(`Move ${HUTUSI} to`)
    await sheet.getByTestId('move-to-option').filter({ hasText: 'Cities' }).click()
    await expect(sheet).toHaveCount(0)
    await expect(settingsGroup(page, 'Cities').getByTestId('settings-subscription')).toHaveCount(2)
    // "+ New folder" in the sheet makes one and moves the blog into it.
    await settingsRow(page, JNITO).getByTestId('move-to').click()
    await page.getByTestId('move-sheet-new-folder').click()
    await page.getByTestId('new-folder-input').fill('Craft')
    await page.getByTestId('new-folder-create').click()
    await expect(settingsGroup(page, 'Craft').getByTestId('settings-subscription')).toHaveText([
      new RegExp(JNITO),
    ])
    // New folder sits in the back bar; ··· holds Rename and Delete folder.
    await expect(page.getByTestId('settings-back-bar').getByTestId('new-folder')).toBeVisible()
    await settingsGroup(page, 'Craft').getByTestId('folder-more').click()
    await expect(page.getByTestId('folder-rename')).toBeVisible()
    await expect(page.getByTestId('folder-delete')).toBeVisible()
    await page.keyboard.press('Escape')

    // The filter keeps the sections it matches, by name or address, accents and case aside.
    const filter = page.getByTestId('subscriptions-filter')
    await filter.fill('GIVE')
    await expect(page.getByTestId('settings-subscription')).toHaveText([new RegExp(JNITO)])
    await expect(page.getByTestId('folder-group')).toHaveCount(1)
    await filter.fill('')
    await expect(page.getByTestId('settings-subscription')).toHaveCount(3)

    // Unsubscribe takes the row away, and its toast's Undo brings it back.
    await settingsRow(page, HUTUSI).getByTestId('settings-unsubscribe').click()
    await expect(settingsRow(page, HUTUSI)).toHaveCount(0)
    const toast = page.getByTestId('toast')
    await expect(toast).toContainText(`Unsubscribed from ${HUTUSI}.`)
    await toast.getByTestId('toast-action').click()
    await expect(settingsRow(page, HUTUSI)).toHaveCount(1)
  })

  test('Settings › Subscriptions with folders fits 320px in French', async ({ browser }) => {
    const { page, feeds } = await member(browser, { width: 320 })
    await page.context().addCookies([{ name: 'tela_locale', value: 'fr', url: BASE }])
    await push(page, [
      { type: 'setProfile', uiLocale: 'fr' },
      { type: 'putFolder', id: 'e2e-folder-fr', name: 'Des blogs que je lis le dimanche matin' },
      { type: 'fileFeed', feedId: feeds.jnito, folderId: 'e2e-folder-fr' },
    ])
    await page.goto('/settings/subscriptions')
    await expect(page.getByTestId('folder-group')).toHaveCount(2)
    await noSidewaysScroll(page, 'Settings › Subscriptions')
    await page.goto('/reading')
    await page.getByTestId('mobile-nav').locator('summary').click()
    await expect(page.getByTestId('mobile-folder')).toBeVisible()
    await noSidewaysScroll(page, 'the Feeds menu')
  })
})

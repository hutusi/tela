/**
 * Folders (ADR 0048):
 * - in the sidebar a folder opens and closes on this device, and its name reads every blog in it
 *   as one list, with the Unread/All switch, Mark all read and its Undo;
 * - a folder deleted elsewhere is gone, not a redirect;
 * - Settings › Subscriptions makes, renames and deletes folders, and moves blogs by menu and by
 *   dragging;
 * - OPML carries them both ways.
 *
 * Each test signs in a member of its own, from an address of its own (sign-in is limited per IP
 * and per address), so the shared member's sidebar stays flat for every other spec.
 */
import { type Browser, expect, type Page, test } from '@playwright/test'
import { addFeed, BASE, cycle, FIXTURES, memberHeaders, signInRequest } from './helpers'

test.use({ storageState: { cookies: [], origins: [] } })

const ORIGIN = { origin: BASE }
/** The fixture blogs each member follows, by the name the sidebar gives them. */
const JVNS = 'Julia Evans'
const JNITO = 'give IT a try'
const HUTUSI = '胡涂说'

let members = 0
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
  await cycle(context.request)
  return { page: await context.newPage(), feeds }
}

/** Changes made as another device makes them: straight to tela-api. */
async function push(page: Page, mutations: Record<string, unknown>[]): Promise<void> {
  const at = Date.now()
  const res = await page.request.post(`${BASE}/api/v1/mutations`, {
    headers: { ...ORIGIN, ...(await memberHeaders(page.request)) },
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

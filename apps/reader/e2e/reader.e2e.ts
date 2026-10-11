/**
 * The reading view, ported from the Postgres app's suite. Everything the old tests asserted about
 * the URL owning the open article still holds; what they asserted about server renders is
 * replaced by the local-first spec, since there is no server render left to count.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { type APIRequestContext, expect, type Page, test } from '@playwright/test'
import {
  BASE,
  ensureFeeds,
  FIXTURES,
  keepCycling,
  memberHeaders,
  readStateOnServer,
  resetReading,
  setPrefs,
  synced,
} from './helpers'

const HOUR = 3_600_000
const DAY = 24 * HOUR

/** The member's rows as the server holds them, through a snapshot pull. */
async function rowsOnServer(api: APIRequestContext) {
  const res = await api.get(`${BASE}/api/v1/sync?cursor=0`, { headers: await memberHeaders(api) })
  if (!res.ok()) throw new Error(`sync failed: ${res.status()} ${await res.text()}`)
  return (
    (await res.json()) as {
      rows: {
        articles: { id: number; feedId: number }[]
        feeds: { id: number; feedUrl: string }[]
        subscriptions: { feedId: number; watermarkId: number; deletedAt: number | null }[]
        states: {
          articleId: number
          readAt: number | null
          readUpdatedAt?: number | null
          likedAt: number | null
        }[]
      }
    }
  ).rows
}

/** How far the server has the member's subscription to a feed read by its watermark. */
async function watermarkOnServer(api: APIRequestContext, feedId: number): Promise<number> {
  const sub = (await rowsOnServer(api)).subscriptions.find((s) => s.feedId === feedId)
  if (!sub) throw new Error(`no subscription to ${feedId}`)
  return sub.watermarkId
}

/** Push changes as the app does, for a state a spec starts from or leaves behind. */
async function push(api: APIRequestContext, mutations: Record<string, unknown>[]): Promise<void> {
  const at = Date.now()
  const res = await api.post(`${BASE}/api/v1/mutations`, {
    headers: { origin: BASE, ...(await memberHeaders(api)) },
    data: { mutations: mutations.map((m) => ({ mid: crypto.randomUUID(), at, ...m })) },
  })
  if (!res.ok()) throw new Error(`push failed: ${res.status()} ${await res.text()}`)
}

/** The bodies of every push the page sends from now on. */
function pushesFrom(page: Page): string[] {
  const pushed: string[] = []
  page.on('request', (r) => {
    if (r.url().includes('/api/v1/mutations')) pushed.push(r.postData() ?? '')
  })
  return pushed
}

const markAllsIn = (pushed: string[]) => pushed.filter((body) => body.includes('"markAllRead"'))

/**
 * Open 胡涂说, a blog with unread posts, and say which: the posts a Mark all read there reads.
 * Every spec that lets one reach tela-api marks them unread again after, for the specs after it.
 */
async function openUnreadBlog(page: Page) {
  await page.goto('/reading')
  await synced(page)
  await page.getByTestId('subscription').filter({ hasText: '胡涂说' }).click()
  await expect(page).toHaveURL(/feed=\d+/)
  const feedId = Number(new URL(page.url()).searchParams.get('feed'))
  const dots = page.getByTestId('unread-dot')
  await expect(dots.first()).toBeVisible()
  const unread = await page
    .getByTestId('article-row')
    .filter({ has: page.getByTestId('unread-dot') })
    .evaluateAll((els) => els.map((el) => Number(el.getAttribute('data-article-id'))))
  return { feedId, dots, unread, watermark: await watermarkOnServer(page.request, feedId) }
}

/** Whether tela-api has each of `ids` marked unread by hand. */
async function unreadOnServer(api: APIRequestContext, ids: number[]): Promise<boolean> {
  const { states } = await rowsOnServer(api)
  return ids.every((id) => {
    const s = states.find((state) => state.articleId === id)
    return s !== undefined && s.readAt === null && s.readUpdatedAt != null
  })
}

test.describe('reader', () => {
  test('signed-in home goes to reading, with the subscriptions from the first sync', async ({
    page,
  }) => {
    await page.goto('/')
    await expect(page).toHaveURL(/\/reading$/)
    const subs = page.getByTestId('subscription')
    await expect(subs.first()).toBeVisible()
    await expect(page.getByTestId('subscription').filter({ hasText: 'Julia Evans' })).toHaveCount(1)
    await expect(page.getByTestId('subscription').filter({ hasText: '胡涂说' })).toHaveCount(1)
    await expect(page.getByTestId('article-row').first()).toBeVisible()
  })

  test('opening an article marks it read and like toggles the counter', async ({ page }) => {
    await page.goto('/reading')
    await synced(page)
    await page.getByTestId('subscription').filter({ hasText: 'Julia Evans' }).click()
    // This feed's own list, not whatever "All articles" still shows.
    await expect(page).toHaveURL(/\/reading\?feed=\d+$/)
    await expect(page.getByTestId('article-row').first()).toContainText('Julia Evans')
    // An unread one: specs before this read the first few. Pinned by its href, since a filter on
    // the dot would move on to the next unread row once this one is read.
    const unread = page.getByTestId('article-row').filter({ has: page.getByTestId('unread-dot') })
    const href = await unread.first().getAttribute('href')
    const row = page.locator(`[data-testid="article-row"][href="${href}"]`)
    const title = (await row.locator('h2').textContent())?.trim() ?? ''
    await row.click()
    await expect(page).toHaveURL(/article=\d+/)
    await expect(page.getByTestId('article-title')).toHaveText(title)
    await expect(page.locator('.article-body').first()).toBeVisible()
    await expect(row.getByTestId('unread-dot')).toHaveCount(0)

    const like = page.getByTestId('like-button')
    await expect(like).toContainText('0')
    await like.click()
    await expect(like).toContainText('1')
    await expect(like).toHaveAttribute('aria-pressed', 'true')
    // The like reaches the server, so a reload (from the device, then the next pull) keeps it.
    await page.waitForResponse((r) => r.url().includes('/api/v1/mutations'))
    await page.reload()
    await expect(page.getByTestId('like-button')).toContainText('1')
    const unliked = page.waitForResponse((r) => r.url().includes('/api/v1/mutations'))
    await page.getByTestId('like-button').click()
    await expect(page.getByTestId('like-button')).toContainText('0')
    await unliked

    await page.getByTestId('close-article').click()
    await expect(page).not.toHaveURL(/article=/)
  })

  test('with marking read on opening turned off, a post stays unread until marked', async ({
    page,
  }) => {
    await page.goto('/settings/reading')
    const toggle = page.getByTestId('pref-mark-on-open')
    await expect(toggle).toHaveAttribute('aria-checked', 'true')
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-checked', 'false')
    try {
      await page.getByTestId('nav-reading').click()
      await synced(page)
      await page.getByTestId('subscription').filter({ hasText: 'Julia Evans' }).click()
      // This feed's own list, not whatever "All articles" still shows.
      await expect(page).toHaveURL(/\/reading\?feed=\d+$/)
      await expect(page.getByTestId('article-row').first()).toContainText('Julia Evans')
      const unread = page.getByTestId('article-row').filter({ has: page.getByTestId('unread-dot') })
      const href = await unread.first().getAttribute('href')
      const row = page.locator(`[data-testid="article-row"][href="${href}"]`)
      await row.click()
      await expect(page.locator('.article-body').first()).toBeVisible()
      await expect(row.getByTestId('unread-dot')).toHaveCount(1)
      await page.getByTestId('mark-read').click()
      await expect(row.getByTestId('unread-dot')).toHaveCount(0)
      await expect(page.getByTestId('mark-read')).toHaveCount(0)
      // And back, with the pref off as with it on.
      await page.getByTestId('mark-unread').click()
      await expect(row.getByTestId('unread-dot')).toHaveCount(1)
      await page.getByTestId('mark-read').click()
      await expect(row.getByTestId('unread-dot')).toHaveCount(0)
      // Read on the server before the page goes, so the next spec does not find it unread.
      const id = await row.getAttribute('data-article-id')
      await expect
        .poll(() => readStateOnServer(page.request, id ?? ''))
        .toEqual({ readAt: true, readUpdatedAt: true })
    } finally {
      await resetReading(page.request)
    }
  })

  test('Mark as unread keeps a post unread across a reload, until it is opened again', async ({
    page,
  }) => {
    // Opening reads, which is what this spec is about: whatever an earlier spec left of the pref.
    await resetReading(page.request)
    await page.goto('/reading')
    await synced(page)
    await page.getByTestId('subscription').filter({ hasText: 'Julia Evans' }).click()
    await expect(page).toHaveURL(/\/reading\?feed=\d+$/)
    await expect(page.getByTestId('article-row').first()).toContainText('Julia Evans')
    const first = page.getByTestId('article-row').first()
    const id = (await first.getAttribute('data-article-id')) ?? ''
    const row = page.locator(`[data-testid="article-row"][data-article-id="${id}"]`)
    const dot = row.getByTestId('unread-dot')
    await row.click()
    await expect(page.locator('.article-body').first()).toBeVisible()
    // Opening read it, so the action row offers the way back.
    await expect(dot).toHaveCount(0)
    await page.getByTestId('mark-unread').click()
    await expect(dot).toHaveCount(1)
    await expect(page.getByTestId('mark-read')).toBeVisible()
    await expect
      .poll(() => readStateOnServer(page.request, id))
      .toEqual({ readAt: false, readUpdatedAt: true })

    // Reloaded with the post open would be an open, which reads it: from the list instead.
    await page.getByTestId('close-article').click()
    await expect(page).not.toHaveURL(/article=/)
    await page.reload()
    await synced(page)
    await expect(row).toBeVisible()
    await expect(dot).toHaveCount(1)

    // Opening it again reads it, as opening reads any unread post.
    await row.click()
    await expect(page.locator('.article-body').first()).toBeVisible()
    await expect(dot).toHaveCount(0)
    await expect(page.getByTestId('mark-unread')).toBeVisible()
    await expect
      .poll(() => readStateOnServer(page.request, id))
      .toEqual({ readAt: true, readUpdatedAt: true })
  })

  test('hiding read posts keeps the one being read, until the reader moves to another list', async ({
    page,
  }) => {
    await page.goto('/reading')
    await synced(page)
    const feed = page.getByTestId('subscription').filter({ hasText: 'Julia Evans' })
    await feed.click()
    await expect(page).toHaveURL(/\/reading\?feed=\d+$/)
    await expect(page.getByTestId('article-row').first()).toContainText('Julia Evans')
    const rows = page.getByTestId('article-row')
    const unread = rows.filter({ has: page.getByTestId('unread-dot') })
    // One post read before the pref, one read after it.
    const earlier = await unread.first().getAttribute('href')
    await page.locator(`[data-testid="article-row"][href="${earlier}"]`).click()
    await expect(page.locator('.article-body').first()).toBeVisible()
    await page.getByTestId('close-article').click()
    await setPrefs(page.request, { 'reader.hide_read': true })
    try {
      await page.reload()
      await synced(page)
      await expect(page.getByTestId('article-row').first()).toContainText('Julia Evans')
      await expect(page.locator(`[data-testid="article-row"][href="${earlier}"]`)).toHaveCount(0)
      const later = await unread.first().getAttribute('href')
      const row = page.locator(`[data-testid="article-row"][href="${later}"]`)
      await row.click()
      await expect(row).toHaveAttribute('data-read', '1')
      await page.getByTestId('close-article').click()
      await expect(row).toBeVisible()
      // Another list, and back: what was read is gone from this one.
      await page.getByTestId('sidebar').getByText('All articles').click()
      await expect(page).toHaveURL(/\/reading$/)
      await feed.click()
      await expect(page).toHaveURL(/\/reading\?feed=\d+$/)
      await expect(page.getByTestId('article-row').first()).toContainText('Julia Evans')
      await expect(page.locator(`[data-testid="article-row"][href="${later}"]`)).toHaveCount(0)
    } finally {
      await resetReading(page.request)
    }
  })

  test('going back to an opened article brings the article back', async ({ page }) => {
    await page.goto('/reading')
    await page.getByTestId('article-row').first().click()
    await expect(page.getByTestId('reader')).toBeVisible()
    const opened = page.url()
    expect(opened).toMatch(/article=\d+/)

    await page.locator('aside').getByRole('link', { name: /Today/ }).click()
    await expect(page).toHaveURL(/\/reading\?filter=today$/)
    await expect(page.getByTestId('reader')).toHaveCount(0)

    await page.goBack()
    await expect(page).toHaveURL(opened)
    await expect(page.getByTestId('reader')).toBeVisible()
    await expect(page.getByTestId('article-title')).toBeVisible()

    await page.goForward()
    await expect(page).toHaveURL(/\/reading\?filter=today$/)
    await expect(page.getByTestId('reader')).toHaveCount(0)
  })

  test('a new article opens at its top, not where the last one was left', async ({ page }) => {
    await page.goto('/reading')
    const rows = page.getByTestId('article-row')
    await rows.first().click()
    await expect(page.getByTestId('reader')).toBeVisible()
    await page.evaluate(() => window.scrollTo(0, 700))
    expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0)

    await rows.nth(1).click()
    await expect(page.getByTestId('reader')).toBeVisible()
    await expect.poll(async () => page.evaluate(() => window.scrollY), { timeout: 5000 }).toBe(0)
    await expect(page.getByTestId('article-title')).toBeInViewport()
  })

  test('a row read during this visit shows as read after the article closes', async ({ page }) => {
    await page.goto('/reading')
    await synced(page)
    await page.getByTestId('subscription').filter({ hasText: 'Julia Evans' }).click()
    await expect(page).toHaveURL(/\/reading\?feed=\d+/)
    await expect(page.getByTestId('article-row').first()).toContainText('Julia Evans')
    const row = page.getByTestId('article-row').nth(2)
    // A read row keeps its full opacity, so its 12px meta stays readable; its title steps back to
    // ink-2 and its dot goes (Tela v5). Polled: the list fades in.
    const opacity = () => row.evaluate((el) => Number(getComputedStyle(el).opacity))
    const title = () => row.locator('h2').evaluate((el) => getComputedStyle(el).color)
    const INK = 'rgb(31, 28, 24)'
    const INK_2 = 'rgb(92, 85, 75)'

    if ((await row.getAttribute('data-read')) === '0') await expect.poll(title).toBe(INK)
    await row.click()
    await expect(page.getByTestId('reader')).toBeVisible()
    // The open row's title stays ink, read or not.
    await expect.poll(title).toBe(INK)
    await page.getByTestId('close-article').click()
    await expect(page.getByTestId('reader')).toHaveCount(0)
    await expect(row).toHaveAttribute('data-read', '1')
    await expect.poll(title).toBe(INK_2)
    await expect(row.getByTestId('unread-dot')).toHaveCount(0)
    await expect.poll(opacity).toBe(1)
  })

  test('opening an article moves focus into it once it is there', async ({ page }) => {
    await page.goto('/reading')
    await page.getByTestId('article-row').first().click()
    await expect(page.getByTestId('reader')).toBeVisible()
    await expect
      .poll(async () => page.evaluate(() => document.activeElement?.getAttribute('data-testid')), {
        timeout: 5000,
      })
      .toBe('reader')
  })

  test('re-opening the article already showing does not stack a history entry', async ({
    page,
  }) => {
    await page.goto('/reading')
    const row = page.getByTestId('article-row').first()
    await row.click()
    await expect(page.getByTestId('reader')).toBeVisible()
    const opened = page.url()

    await row.click()
    await expect(page).toHaveURL(opened)
    await expect(page.getByTestId('reader')).toBeVisible()

    await page.goBack()
    await expect(page).not.toHaveURL(/article=/)
    await expect(page.getByTestId('reader')).toHaveCount(0)
  })

  test('nor does it when the URL spells the same state differently', async ({ page }) => {
    await page.goto('/reading')
    const href = await page.getByTestId('article-row').first().getAttribute('href')
    const id = new URL(href ?? '', 'http://x').searchParams.get('article')

    await page.goto(`/reading?mode=side&article=${id}`)
    await expect(page.getByTestId('reader')).toBeVisible()
    const before = await page.evaluate(() => history.length)

    await page.getByTestId('article-row').first().click()
    await expect(page.getByTestId('reader')).toBeVisible()
    expect(await page.evaluate(() => history.length)).toBe(before)
  })

  test('filter and subscription navigations close an opened article', async ({ page }) => {
    await page.goto('/reading')
    await page.getByTestId('article-row').first().click()
    await expect(page.getByTestId('reader')).toBeVisible()

    await page.locator('aside').getByRole('link', { name: /Today/ }).click()
    await expect(page).toHaveURL(/\/reading\?filter=today$/)
    await expect(page.getByTestId('reader')).toHaveCount(0)
    await expect(page.getByTestId('reading-layout')).not.toHaveAttribute('data-open')

    await page.locator('aside a[href="/reading"]').click()
    await expect(page).toHaveURL(/\/reading$/)
    await page.getByTestId('article-row').first().click()
    await expect(page.getByTestId('reader')).toBeVisible()
    await page.getByTestId('subscription').first().click()
    await expect(page).toHaveURL(/\/reading\?feed=\d+$/)
    await expect(page.getByTestId('reader')).toHaveCount(0)
    await expect(page.getByTestId('reading-layout')).not.toHaveAttribute('data-open')
  })

  test('a direct link to a missing article says it is gone', async ({ page }) => {
    await page.goto('/reading?article=999999999')
    await expect(page.getByTestId('article-gone')).toBeVisible()
    await expect(page.getByTestId('reading-layout')).toHaveAttribute('data-open', '1')

    await page.getByTestId('article-gone').getByRole('button', { name: 'Close' }).click()
    await expect(page).toHaveURL(/\/reading$/)
    await expect(page.getByTestId('article-gone')).toHaveCount(0)
    await expect(page.getByTestId('article-list')).toBeVisible()
  })

  test('unliking in the Liked view takes the article out of the list', async ({ page }) => {
    await page.goto('/reading')
    await synced(page)
    await page.getByTestId('subscription').filter({ hasText: 'Julia Evans' }).click()
    await expect(page).toHaveURL(/\/reading\?feed=\d+/)
    await page.getByTestId('article-row').first().click()
    await expect(page).toHaveURL(/article=\d+/)
    const articleId = new URL(page.url()).searchParams.get('article')
    const likeButton = page.getByTestId('like-button')
    if ((await likeButton.getAttribute('aria-pressed')) !== 'true') await likeButton.click()
    await expect(likeButton).toHaveAttribute('aria-pressed', 'true')

    // Other specs like posts too (recommending one likes it): count from what is there.
    await page.locator('aside').getByRole('link', { name: /Liked/ }).click()
    const liked = page.getByTestId('article-row')
    await expect(page).toHaveURL(/filter=liked$/)
    // Its href in the Liked list, so this waits for that list rather than the feed's.
    const mine = page.locator(
      `[data-testid="article-row"][href="/reading?filter=liked&article=${articleId}"]`,
    )
    await expect(mine).toHaveCount(1)
    const before = await liked.count()
    await mine.click()
    await expect(page).toHaveURL(new RegExp(`article=${articleId}(&|$)`))

    await page.getByTestId('like-button').click()
    await expect(page.getByTestId('like-button')).toHaveAttribute('aria-pressed', 'false')
    await expect(mine).toHaveCount(0)
    await expect(liked).toHaveCount(before - 1)
  })

  test('mark all read clears the counts for one feed, and Undo takes it back before it is sent', async ({
    page,
  }) => {
    await resetReading(page.request)
    // Everything the page pushes: the mark-all, once taken back, must never be among it.
    const pushed: string[] = []
    page.on('request', (r) => {
      if (r.url().includes('/api/v1/mutations')) pushed.push(r.postData() ?? '')
    })
    await page.goto('/reading')
    await synced(page)
    const feed = page.getByTestId('subscription').filter({ hasText: '胡涂说' })
    await feed.click()
    await expect(page).toHaveURL(/feed=\d+/)
    const feedId = Number(new URL(page.url()).searchParams.get('feed'))
    const count = feed.locator('span').last()
    const dots = page.getByTestId('unread-dot')
    await expect(dots.first()).toBeVisible()
    const unread = Number(await count.textContent())
    expect(unread).toBeGreaterThan(0)
    await expect(dots).toHaveCount(unread)
    const watermark = await watermarkOnServer(page.request, feedId)

    await page.getByTestId('mark-all-read').click()
    await expect(dots).toHaveCount(0)
    await expect(count).toHaveText('')
    const toast = page.getByTestId('toast')
    await expect(toast).toContainText(`Marked ${unread} ${unread === 1 ? 'post' : 'posts'} read.`)
    await page.getByTestId('toast-action').click()
    await expect(toast).toHaveCount(0)
    await expect(dots).toHaveCount(unread)
    await expect(count).toHaveText(String(unread))

    // Held on the device while the toast showed, and taken back there: a reload, which lets go
    // of anything still held, sends nothing, and the server's watermark never moved.
    await page.reload()
    await synced(page)
    await expect(dots).toHaveCount(unread)
    await expect(count).toHaveText(String(unread))
    expect(await watermarkOnServer(page.request, feedId)).toBe(watermark)
    expect(pushed.filter((body) => body.includes('"markAllRead"'))).toEqual([])
  })

  test('pressed twice, Mark all read still sends nothing once undone', async ({ page }) => {
    await resetReading(page.request)
    const pushed = pushesFrom(page)
    const { feedId, dots, unread, watermark } = await openUnreadBlog(page)
    const toast = page.getByTestId('toast')
    await page.getByTestId('mark-all-read').click()
    await expect(toast).toContainText(`Marked ${unread.length} `)
    // The second finds nothing unread: it makes no change and says nothing, so the first one's
    // Undo still shows, and takes back all there is.
    await page.getByTestId('mark-all-read').click()
    await expect(toast).toContainText(`Marked ${unread.length} `)
    await page.getByTestId('toast-action').click()
    await expect(toast).toHaveCount(0)
    await expect(dots).toHaveCount(unread.length)

    await page.reload()
    await synced(page)
    await expect(dots).toHaveCount(unread.length)
    expect(await watermarkOnServer(page.request, feedId)).toBe(watermark)
    expect(markAllsIn(pushed)).toEqual([])
  })

  test('a mark-all left alone goes to tela-api once its toast has gone, not before', async ({
    page,
  }) => {
    await resetReading(page.request)
    await page.clock.install()
    const pushed = pushesFrom(page)
    const { feedId, dots, unread, watermark } = await openUnreadBlog(page)
    try {
      await page.getByTestId('mark-all-read').click()
      await expect(dots).toHaveCount(0)
      const toast = page.getByTestId('toast')
      await expect(toast).toBeVisible()
      // Long past the push's quarter-second, and still held: the toast is still up.
      await page.clock.runFor(3000)
      await expect(toast).toBeVisible()
      expect(markAllsIn(pushed)).toEqual([])
      // The toast's five seconds are up, and the change goes with it.
      await page.clock.runFor(3000)
      await expect(toast).toHaveCount(0)
      await expect.poll(() => watermarkOnServer(page.request, feedId)).toBeGreaterThan(watermark)
      expect(markAllsIn(pushed)).toHaveLength(1)
    } finally {
      await push(
        page.request,
        unread.map((articleId) => ({ type: 'markUnread', articleId })),
      )
    }
  })

  test('an Undo after the mark-all went anyway marks what it read unread on tela-api', async ({
    page,
  }) => {
    await resetReading(page.request)
    const { feedId, dots, unread, watermark } = await openUnreadBlog(page)
    try {
      await page.getByTestId('mark-all-read').click()
      await expect(dots).toHaveCount(0)
      const toast = page.getByTestId('toast')
      // A pointer over the toast stops its time, so it is still up when the tab comes back.
      await toast.hover()
      // The tab is hidden: everything held goes now, in case the page never comes back.
      const sent = page.waitForResponse((r) => r.url().includes('/api/v1/mutations') && r.ok())
      await page.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
        document.dispatchEvent(new Event('visibilitychange'))
      })
      await sent
      await page.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
        document.dispatchEvent(new Event('visibilitychange'))
      })
      await expect.poll(() => watermarkOnServer(page.request, feedId)).toBeGreaterThan(watermark)

      // Too late to take back, so the Undo marks each post it read unread, after it.
      await expect(toast).toBeVisible()
      await page.getByTestId('toast-action').click()
      await expect(toast).toHaveCount(0)
      await expect(dots).toHaveCount(unread.length)
      await expect.poll(() => unreadOnServer(page.request, unread)).toBe(true)
    } finally {
      await push(
        page.request,
        unread.map((articleId) => ({ type: 'markUnread', articleId })),
      )
    }
  })

  test('on Today, Mark all read reads the posts it lists, and no older one', async ({ page }) => {
    await resetReading(page.request)
    // A blog that wrote in the last day, which every other fixture did not. The setup's member
    // has never read it: Discover's spec subscribes to it and leaves it again.
    await ensureFeeds(['/fresh/en.xml'])
    try {
      // Today is the last 24 hours on the browser's clock, and the blog's newest post is from
      // four hours before midnight UTC: late in the UTC day, the clock goes back to keep it in.
      const midnight = Math.floor(Date.now() / DAY) * DAY
      await page.clock.install({ time: Math.min(Date.now(), midnight + 18 * HOUR) })
      await page.goto('/reading?filter=today')
      await synced(page)
      const rows = page.getByTestId('article-row')
      await expect(rows.first()).toBeVisible()
      const listed = await rows.evaluateAll((els) =>
        els.map((el) => Number(el.getAttribute('data-article-id'))),
      )
      // An older post of another blog, unread only for being above its blog's watermark: the
      // mark-all Today used to send moved every blog's watermark up to its newest post.
      const before = await rowsOnServer(page.request)
      const watermarks = new Map(
        before.subscriptions.filter((s) => s.deletedAt === null).map((s) => [s.feedId, s]),
      )
      const touched = new Set(
        before.states
          .filter((s) => s.readAt !== null || s.readUpdatedAt != null)
          .map((s) => s.articleId),
      )
      const todays = new Set(
        before.articles.filter((a) => listed.includes(a.id)).map((a) => a.feedId),
      )
      const older = before.articles
        .filter(
          (a) =>
            !todays.has(a.feedId) &&
            a.id < Math.max(...listed) &&
            a.id > (watermarks.get(a.feedId)?.watermarkId ?? Number.POSITIVE_INFINITY) &&
            !touched.has(a.id),
        )
        .sort((a, b) => b.id - a.id)[0]
      if (!older) throw new Error('no older post unread below the Today list')

      const sent = page.waitForResponse((r) => r.url().includes('/api/v1/mutations') && r.ok())
      await page.getByTestId('mark-all-read').click()
      await expect(page.getByTestId('toast')).toContainText(/^Marked \d+ posts? read\./)
      await expect(page.getByTestId('unread-dot')).toHaveCount(0)
      // Held while its toast shows, as a mark-all is: sent once the toast has gone.
      await page.clock.runFor(6000)
      await expect(page.getByTestId('toast')).toHaveCount(0)
      await sent

      expect(await watermarkOnServer(page.request, older.feedId)).toBeLessThan(older.id)
      await page.goto(`/reading?feed=${older.feedId}`)
      await expect(
        page
          .locator(`[data-testid="article-row"][data-article-id="${older.id}"]`)
          .getByTestId('unread-dot'),
      ).toHaveCount(1)
    } finally {
      // As Discover's spec leaves the member: a post from today would top every list after this.
      const fresh = (await rowsOnServer(page.request)).feeds.find((f) =>
        f.feedUrl.endsWith('/fresh/en.xml'),
      )
      if (fresh) await push(page.request, [{ type: 'unsubscribe', feedId: fresh.id }])
    }
  })

  test('Liked has no Mark all read, since liking a post read it', async ({ page }) => {
    const rows = await rowsOnServer(page.request)
    const liked = new Set(rows.states.filter((s) => s.likedAt !== null).map((s) => s.articleId))
    const post = rows.articles.find((a) => !liked.has(a.id))
    if (!post) throw new Error('every post is liked')
    await push(page.request, [{ type: 'setLiked', articleId: post.id, liked: true }])
    try {
      await page.goto('/reading?filter=liked')
      await synced(page)
      await expect(
        page.locator(`[data-testid="article-row"][data-article-id="${post.id}"]`),
      ).toBeVisible()
      await expect(page.getByTestId('mark-all-read')).toHaveCount(0)
    } finally {
      await push(page.request, [{ type: 'setLiked', articleId: post.id, liked: false }])
    }
  })

  test('the UI switches to Chinese in Settings, and the header says so', async ({ page }) => {
    await resetReading(page.request)
    await page.goto('/settings/translation')
    // Linked, the header's circle is the interface language, so it changes with it.
    const circle = page.getByTestId('language-menu').locator('summary')
    await expect(circle).toHaveAccessibleName('Language: English')
    // Each push is waited for: every spec signs in as this member, and the next one should not
    // inherit Chinese because this page closed before its last change went out.
    const pushed = () =>
      page.waitForResponse((r) => r.url().includes('/api/v1/mutations') && r.ok())
    let push = pushed()
    await page.getByTestId('ui-locale').selectOption('zh-Hans')
    await expect(page.getByTestId('nav-reading')).toHaveText('阅读')
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-Hans')
    await expect(circle).toHaveAccessibleName('语言：简体中文')
    await push
    push = pushed()
    await page.getByTestId('ui-locale').selectOption('en')
    await expect(page.getByTestId('nav-reading')).toHaveText('Reading')
    await push
  })

  test('add a feed by page URL, and its posts arrive by sync', async ({ page }) => {
    await page.goto('/add')
    await page.getByTestId('feed-url').fill(`${FIXTURES}/blog`)
    await page.getByTestId('find-feeds').click()
    const candidates = page.getByTestId('feed-candidates')
    await expect(candidates).toContainText('jnito')
    await candidates.getByTestId('subscribe').first().click()
    await expect(page).toHaveURL(/\/reading\?feed=\d+/)
    const stop = keepCycling(page)
    try {
      await expect(page.getByTestId('article-row').first()).toBeVisible({ timeout: 45_000 })
    } finally {
      stop()
    }
  })

  test('OPML import subscribes to new feeds and skips bad entries', async ({ page }) => {
    await page.goto('/add')
    // The file names the default fixture port; this run's may be another, and a feed on a port
    // some other stack answers would subscribe this member to that stack's posts.
    const opml = readFileSync(join(import.meta.dirname, 'fixtures', 'subs.opml'), 'utf8')
    await page.getByTestId('opml-file').setInputFiles({
      name: 'subs.opml',
      mimeType: 'text/x-opml',
      buffer: Buffer.from(opml.replaceAll('http://127.0.0.1:4790', FIXTURES)),
    })
    await page.getByTestId('opml-import').click()
    await expect(page.getByTestId('opml-result')).toContainText(/Imported \d+ blog/)
  })

  test('a summary-only feed gets its full text fetched', async ({ page }) => {
    await page.goto('/add')
    await page.getByTestId('feed-url').fill(`${FIXTURES}/summary.xml`)
    await page.getByTestId('find-feeds').click()
    const candidates = page.getByTestId('feed-candidates')
    await expect(candidates).toContainText('Summary Fixture')
    await candidates.getByTestId('subscribe').first().click()
    await expect(page).toHaveURL(/\/reading\?feed=\d+/)
    const stop = keepCycling(page)
    try {
      const row = page.getByTestId('article-row').first()
      await expect(row).toBeVisible({ timeout: 45_000 })
      await row.click()
      await expect(page).toHaveURL(/article=\d+/)
      // Extraction is eager: the sweeps fetch the page, and the new version arrives by sync.
      await expect(page.locator('.article-body').first()).toContainText('Full paragraph 8', {
        timeout: 45_000,
      })
      await expect(page.getByTestId('extracting')).toHaveCount(0)
    } finally {
      stop()
    }
  })

  test('the end of an article offers the next post in the list, the one j would open', async ({
    page,
  }) => {
    await page.goto('/reading')
    await synced(page)
    await page.getByTestId('subscription').filter({ hasText: 'Julia Evans' }).click()
    await expect(page).toHaveURL(/\/reading\?feed=\d+$/)
    const rows = page.getByTestId('article-row')
    await expect(rows.first()).toContainText('Julia Evans')
    const second = await rows.nth(1).getAttribute('data-article-id')
    const secondTitle = (await rows.nth(1).locator('h2').textContent())?.trim() ?? ''

    await rows.first().click()
    await expect(page).toHaveURL(/article=\d+/)
    const next = page.getByTestId('next-article')
    await expect(next).toContainText(secondTitle)
    // Whose it is, as the label says: capitals are the stylesheet's, not the words'.
    await expect(next).toContainText('Up next · Julia Evans')
    await next.click()
    await expect(page).toHaveURL(new RegExp(`article=${second}$`))
    await expect(page.getByTestId('article-title')).toHaveText(secondTitle)

    // The last post has nothing after it.
    await rows.last().click()
    await expect(page).toHaveURL(/article=\d+/)
    await expect(page.getByTestId('next-article')).toHaveCount(0)
  })

  test('the end of an article likes it, and recommends it with a note in a box of its own', async ({
    page,
  }) => {
    await page.goto('/reading')
    await synced(page)
    await page.getByTestId('subscription').filter({ hasText: 'Julia Evans' }).click()
    await expect(page).toHaveURL(/\/reading\?feed=\d+$/)
    const rows = page.getByTestId('article-row')
    await expect(rows.first()).toContainText('Julia Evans')
    // Not the first, which the recommendation and dashboard spec recommends.
    await rows.nth(2).click()
    await expect(page).toHaveURL(/article=\d+/)

    const actions = page.getByTestId('end-actions')
    await expect(actions).toContainText('The author sees how many liked this')
    await expect(page.getByTestId('end-blog')).toContainText('Julia Evans')

    // Like or Liked, with no count, and the toolbar's like follows.
    const like = page.getByTestId('end-like')
    const was = (await like.getAttribute('aria-pressed')) === 'true'
    await like.click()
    await expect(like).toHaveAttribute('aria-pressed', String(!was))
    await expect(like).toHaveText(was ? 'Like' : 'Liked')
    await expect(page.getByTestId('like-button')).toHaveAttribute('aria-pressed', String(!was))
    await like.click()
    await expect(like).toHaveAttribute('aria-pressed', String(was))

    const recommend = page.getByTestId('end-recommend')
    if ((await recommend.getAttribute('aria-pressed')) === 'true') await recommend.click()
    await expect(recommend).toHaveText('Recommend')
    await recommend.click()
    // The form opens under the row, not in the toolbar's popover, with the field ready to type in.
    const box = page.getByTestId('recommend-inline')
    const field = box.getByTestId('recommend-note')
    await expect(box).toContainText('Recommend to your readers')
    await expect(page.getByTestId('recommend-popover')).toHaveCount(0)
    await expect(field).toBeFocused()
    await expect(field).toHaveAttribute('placeholder', 'Why should they read this? (optional)')
    await field.fill('Read it for the diagrams.')
    const sent = page.waitForResponse(
      (r) =>
        r.url().includes('/api/v1/mutations') &&
        r.ok() &&
        (r.request().postData() ?? '').includes('Read it for the diagrams.'),
    )
    await box.getByTestId('recommend-submit').click()
    await expect(page.getByTestId('toast')).toContainText('Recommended with your note.')
    await expect(box).toHaveCount(0)
    await expect(recommend).toHaveAttribute('aria-pressed', 'true')
    await expect(recommend).toHaveText('Recommended')
    await expect(page.getByTestId('recommend-button')).toHaveAttribute('aria-pressed', 'true')
    await sent

    // Recommended, the same button takes it back, as the toolbar's does; the push is waited for,
    // so no later spec meets it.
    const taken = page.waitForResponse(
      (r) =>
        r.url().includes('/api/v1/mutations') &&
        r.ok() &&
        (r.request().postData() ?? '').includes('unrecommend'),
    )
    await recommend.click()
    await expect(page.getByTestId('toast')).toContainText('Recommendation removed.')
    await expect(recommend).toHaveAttribute('aria-pressed', 'false')
    await taken

    // A phone's bars are not drawn at 1280, and leave the toast where it was.
    for (const id of ['back-bar', 'bottom-bar', 'bar-like', 'bar-recommend', 'bar-original']) {
      await expect(page.getByTestId(id)).toHaveCount(0)
    }
    const variable = await page.evaluate(() =>
      document.documentElement.style.getPropertyValue('--bottom-bar'),
    )
    expect(variable).toBe('')
    await expect(page.getByTestId('close-article')).toBeVisible()
  })
})

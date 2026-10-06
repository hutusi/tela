/**
 * The reading view, ported from the Postgres app's suite. Everything the old tests asserted about
 * the URL owning the open article still holds; what they asserted about server renders is
 * replaced by the local-first spec, since there is no server render left to count.
 */
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { FIXTURES, keepCycling, resetReading, setPrefs, synced } from './helpers'

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
    } finally {
      await resetReading(page.request)
    }
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

  test('a row read during this visit stays dimmed after the article closes', async ({ page }) => {
    await page.goto('/reading')
    await synced(page)
    await page.getByTestId('subscription').filter({ hasText: 'Julia Evans' }).click()
    await expect(page).toHaveURL(/\/reading\?feed=\d+/)
    await expect(page.getByTestId('article-row').first()).toContainText('Julia Evans')
    const row = page.getByTestId('article-row').nth(2)
    // Polled: the list fades in, so a first reading can land mid-animation.
    const opacity = () => row.evaluate((el) => Number(getComputedStyle(el).opacity))

    if ((await row.getAttribute('data-read')) === '0') await expect.poll(opacity).toBe(1)
    await row.click()
    await expect(page.getByTestId('reader')).toBeVisible()
    await page.getByTestId('close-article').click()
    await expect(page.getByTestId('reader')).toHaveCount(0)
    await expect(row).toHaveAttribute('data-read', '1')
    await expect.poll(opacity).toBeLessThan(1)
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

  test('mark all read clears the counts for one feed', async ({ page }) => {
    await page.goto('/reading')
    await synced(page)
    await page.getByTestId('subscription').filter({ hasText: '胡涂说' }).click()
    await expect(page).toHaveURL(/feed=\d+/)
    await page.getByTestId('mark-all-read').click()
    await expect(page.getByTestId('unread-dot')).toHaveCount(0)
    await expect(
      page.getByTestId('subscription').filter({ hasText: '胡涂说' }).locator('span').last(),
    ).toHaveText('')
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
    await page
      .getByTestId('opml-file')
      .setInputFiles(join(import.meta.dirname, 'fixtures', 'subs.opml'))
    await page.getByTestId('opml-import').click()
    await expect(page.getByTestId('opml-result')).toContainText(/Imported \d+ feed/)
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
    await next.click()
    await expect(page).toHaveURL(new RegExp(`article=${second}$`))
    await expect(page.getByTestId('article-title')).toHaveText(secondTitle)

    // The last post has nothing after it.
    await rows.last().click()
    await expect(page).toHaveURL(/article=\d+/)
    await expect(page.getByTestId('next-article')).toHaveCount(0)
  })
})

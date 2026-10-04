import { expect, test } from '@playwright/test'
import { resetReading, setPrefs } from './helpers'

// Runs in the `mobile` project (a Pixel 7 viewport), as the setup's member.
test.describe('mobile fallback', () => {
  test('the list and the article stack, with feeds behind a disclosure', async ({ page }) => {
    await page.goto('/reading')
    await page.getByTestId('subscription').first().waitFor({ state: 'attached' })
    await expect(page.getByTestId('subscription').first()).toBeHidden()
    const nav = page.getByTestId('mobile-nav')
    await expect(nav).toBeVisible()
    await nav.locator('summary').click()
    // A feed with posts: specs before this one add feeds the fixture server may not serve.
    const sub = page.getByTestId('mobile-subscription').filter({ hasText: 'Julia Evans' }).first()
    const title = (await sub.textContent())?.trim() ?? ''
    await sub.click()
    await expect(page).toHaveURL(/feed=\d+/)
    await expect(page.getByTestId('mobile-nav')).toContainText(title.slice(0, 6))

    await page.getByTestId('article-row').first().click()
    await expect(page).toHaveURL(/article=\d+/)
    await expect(page.getByTestId('reader')).toBeVisible()
    await expect(page.getByTestId('article-list')).toBeHidden()
    await expect(page.getByTestId('mobile-nav')).toHaveCount(0)
    // No horizontal overflow: the page body must not scroll sideways.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    )
    expect(overflow).toBeLessThanOrEqual(0)

    await page.getByTestId('close-article').click()
    await expect(page.getByTestId('article-list')).toBeVisible()
    await expect(page.getByTestId('mobile-nav')).toBeVisible()
  })

  test('Manage beside the feeds opens the list in Settings', async ({ page }) => {
    await page.goto('/reading')
    const nav = page.getByTestId('mobile-nav')
    await nav.locator('summary').click()
    await nav.getByTestId('manage-subscriptions').click()
    await expect(page).toHaveURL(/\/settings\/subscriptions$/)
    await expect(page.getByTestId('settings-content')).toHaveAttribute(
      'data-section',
      'subscriptions',
    )
  })

  test('the Read-in menu stays on one line on a phone, and its list on screen', async ({
    page,
  }) => {
    // Two characters can break between them where "EN" never could, and the phone's header has
    // no room to spare: each of the button's words stays one line all the same.
    await setPrefs(page.request, {}, { readingLang: 'zh-Hant' })
    try {
      await page.goto('/reading')
      const readIn = page.getByTestId('read-in')
      const summary = readIn.locator('summary')
      await expect(summary).toHaveAccessibleName('Read in 繁中')
      const heights = await summary
        .locator('span')
        .evaluateAll((spans) => spans.map((s) => Math.round(s.getBoundingClientRect().height)))
      for (const height of heights) expect(height, `span heights ${heights}`).toBeLessThan(24)
      // The list opens under the button, right-aligned to it, and fits the phone.
      await summary.click()
      await expect(readIn.getByTestId('read-in-zh-Hant')).toBeVisible()
      const panel = await readIn.evaluate((el) => {
        const box = el.querySelector('div')?.getBoundingClientRect()
        const viewport = document.documentElement.clientWidth
        return { left: box?.left ?? -1, right: box?.right ?? viewport + 1, viewport }
      })
      expect(panel.left, 'list off the left edge').toBeGreaterThanOrEqual(0)
      expect(panel.right, 'list off the right edge').toBeLessThanOrEqual(panel.viewport)
    } finally {
      await resetReading(page.request)
    }
  })

  test('the theme menu stays out of the header on a phone', async ({ page }) => {
    // Below `sm` the header's room is the nav's; Settings and the Aa menu choose the theme there.
    await page.goto('/reading')
    await expect(page.getByTestId('account-menu')).toBeVisible()
    await expect(page.getByTestId('theme-menu')).toHaveCount(1)
    await expect(page.getByTestId('theme-menu')).toBeHidden()
  })

  test('the account menu opens on a phone, and holds the way to Settings', async ({ page }) => {
    await page.goto('/reading')
    await page.getByTestId('account-menu').click()
    const panel = page.getByTestId('account-panel')
    await expect(panel).toBeVisible()
    const box = await panel.boundingBox()
    const width = page.viewportSize()?.width ?? 0
    expect(box && box.x >= 0 && box.x + box.width <= width, 'menu inside the screen').toBe(true)
    await page.getByTestId('nav-settings').click()
    await expect(page).toHaveURL(/\/settings$/)
    await expect(panel).toHaveCount(0)
  })
})

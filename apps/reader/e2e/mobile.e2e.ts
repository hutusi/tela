import { expect, test } from '@playwright/test'

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

  test('中文 in the Read-in pill stays on one line on a phone', async ({ page }) => {
    await page.goto('/reading')
    const pill = page.getByTestId('read-in')
    await pill.waitFor()
    // Two characters can break between them where "ZH" never could: each choice is one line.
    const heights = await pill
      .getByRole('button')
      .evaluateAll((buttons) => buttons.map((b) => Math.round(b.getBoundingClientRect().height)))
    expect(new Set(heights).size, `button heights ${heights}`).toBe(1)
  })

  test('the theme switch stays out of the header on a phone', async ({ page }) => {
    // Below `sm` the header's room is the nav's; Settings and the Aa menu choose the theme there.
    await page.goto('/reading')
    await expect(page.getByTestId('account-menu')).toBeVisible()
    await expect(page.getByTestId('theme-toggle')).toHaveCount(1)
    await expect(page.getByTestId('theme-toggle')).toBeHidden()
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

import { expect, test } from '@playwright/test'
import { BASE, resetReading, setPrefs } from './helpers'

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

  test('the language circle stays round on a phone, and its list on screen', async ({ page }) => {
    // The one header control for a language at every width: the phone's header has no room to
    // spare, and the circle is the theme menu's size whatever it shows.
    await setPrefs(page.request, {}, { readingLang: 'zh-Hant' })
    try {
      await page.goto('/reading')
      const menu = page.getByTestId('language-menu')
      const summary = menu.locator('summary')
      await expect(summary).toHaveAccessibleName('Translate into: 繁體中文')
      await expect(summary.locator('[aria-hidden="true"]')).toHaveText('繁')
      const box = await summary.boundingBox()
      expect(box && { width: Math.round(box.width), height: Math.round(box.height) }).toEqual({
        width: 34,
        height: 34,
      })
      // The list opens under the circle, right-aligned to it, and fits the phone.
      await summary.click()
      await expect(menu.getByTestId('language-menu-zh-Hant')).toBeVisible()
      const panel = await menu.evaluate((el) => {
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

test.describe('Discover on a phone', () => {
  test.use({ storageState: { cookies: [], origins: [] } })

  test('every tab is in reach, in French, and the page never scrolls sideways', async ({
    page,
    context,
  }) => {
    await context.addCookies([{ name: 'tela_locale', value: 'fr', url: BASE }])
    await page.goto('/discover')
    await expect(page.locator('html')).toHaveAttribute('lang', 'fr')
    for (const tab of ['readers', 'articles', 'blogs', 'week']) {
      const link = page.getByTestId(`discover-tab-${tab}`)
      await link.scrollIntoViewIfNeeded()
      await link.click()
      await expect(page.getByTestId(`discover-tab-${tab}`)).toHaveAttribute('aria-current', 'page')
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      )
      expect(overflow).toBeLessThanOrEqual(0)
    }
  })
})

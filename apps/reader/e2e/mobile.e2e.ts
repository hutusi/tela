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
})

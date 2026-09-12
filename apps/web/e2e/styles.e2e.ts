import { expect, type Locator, test } from '@playwright/test'

/**
 * What the class strings claim, checked against what the browser computes.
 *
 * These would all have passed as source review. The `a` rules in globals.css sat outside any
 * cascade layer, and an unlayered declaration outranks every layered one — including `@layer
 * utilities`, where Tailwind puts everything. So `text-ink` and `hover:no-underline` on the header
 * links resolved to nothing, and the whole chrome rendered accent green and underlined on hover
 * while the JSX said otherwise. Only a rendering browser can tell the difference.
 */

const INK = 'rgb(31, 28, 24)'

const colour = (l: Locator) => l.evaluate((el) => getComputedStyle(el).color)
const decoration = (l: Locator) => l.evaluate((el) => getComputedStyle(el).textDecorationLine)

test.describe('stylesheet', () => {
  test('the header renders in ink and never underlines', async ({ page }) => {
    await page.goto('/reading')

    const brand = page.getByRole('banner').getByRole('link', { name: 'Tela' })
    expect(await colour(brand)).toBe(INK)
    expect(await decoration(brand)).toBe('none')
    await brand.hover()
    expect(await decoration(brand)).toBe('none')

    // Ink in every state: the design carries the active pill on its background alone, so a colour
    // difference here would be a second signal for the same thing.
    for (const key of ['reading', 'discover', 'dashboard', 'settings']) {
      const pill = page.getByTestId(`nav-${key}`)
      expect(await colour(pill), key).toBe(INK)
      expect(await decoration(pill), key).toBe('none')
      await pill.hover()
      expect(await decoration(pill), key).toBe('none')
    }
  })

  test('the mark sits in the header lockup', async ({ page }) => {
    await page.goto('/reading')
    const mark = page.getByRole('banner').getByRole('link', { name: 'Tela' }).locator('svg')
    await expect(mark).toBeVisible()
    // aria-hidden, because the wordmark beside it already says the name.
    await expect(mark).toHaveAttribute('aria-hidden', 'true')
  })

  test('a link inside a post keeps its underline', async ({ page }) => {
    await page.goto('/reading')
    // .first(): earlier specs add feeds, so by the time this runs the name is not unique.
    await page.getByTestId('subscription').filter({ hasText: 'Julia Evans' }).first().click()
    await page.getByTestId('article-row').first().click()
    await expect(page.locator('.article-body')).toBeVisible()

    // The .article-body rules stay unlayered on purpose. Prose links need an affordance the
    // chrome does not, and layering them alongside the rest would take it away everywhere.
    const link = page.locator('.article-body a').first()
    await expect(link).toBeAttached()
    expect(await decoration(link)).toBe('underline')
  })
})

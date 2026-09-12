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

  /**
   * The header's breakpoint used to be `md`, where the wordmark and a fixed 240px search field
   * arrived together and cost more width than 768px had. The nav lost the contest: measured on
   * main it was 4px wide at 768 and 36px at 800, so Dashboard and Settings were unreachable with a
   * pointer from 768px to about 1100px. The matrix ran 412 and 1280 and saw none of it.
   */
  for (const width of [640, 768, 800, 1024, 1280]) {
    test(`the header fits and keeps its nav at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 })
      await page.goto('/reading')
      // The Read-in menu streams in behind Suspense and is 133px wide. Measuring before it lands
      // reads a header ~145px lighter than the one a member sees, which passes when it shouldn't.
      await page.getByTestId('read-in').waitFor({ state: 'attached' })

      const m = await page.evaluate(() => {
        const doc = document.documentElement
        const nav = document.querySelector('header nav') as HTMLElement
        const pill = nav.querySelector('a') as HTMLElement
        return {
          overflow: doc.scrollWidth - doc.clientWidth,
          client: nav.clientWidth,
          scroll: nav.scrollWidth,
          pill: Math.round(pill.getBoundingClientRect().width),
        }
      })
      expect(m.overflow, 'horizontal overflow').toBeLessThanOrEqual(0)
      // The pill row may scroll here; being squeezed below one pill is the failure. There is no
      // other route to Dashboard or Settings, and a 4px nav — which is what main renders at 768 —
      // leaves nothing to grab and nothing to read.
      expect(m.client, 'nav narrower than a single pill').toBeGreaterThanOrEqual(m.pill)
      if (width >= 800) expect(m.client, 'nav is clipped').toBe(m.scroll)
    })
  }

  test('search is reachable below the desktop breakpoint too', async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 900 })
    await page.goto('/reading')
    // The field costs 240px the nav needs, so below lg it collapses to a link to the same page.
    await expect(page.getByTestId('search-input')).toBeHidden()
    await page.getByTestId('search-link').click()
    await expect(page).toHaveURL(/\/search$/)

    await page.setViewportSize({ width: 1280, height: 900 })
    await page.goto('/reading')
    await expect(page.getByTestId('search-input')).toBeVisible()
    await expect(page.getByTestId('search-link')).toBeHidden()
  })
})

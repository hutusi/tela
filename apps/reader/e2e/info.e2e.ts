/**
 * About, Privacy and Terms (ADR 0035): open to anyone, rendered at the edge so they read without
 * JavaScript, in both interface languages, with section anchors that are the same in each.
 */
import { expect, test } from '@playwright/test'
import { BASE } from './helpers'

test.use({ storageState: { cookies: [], origins: [] } })

test.describe('without JavaScript', () => {
  test.use({ javaScriptEnabled: false })

  test('each page is whole from the edge, and never indexed in the beta', async ({ page }) => {
    for (const [path, title] of [
      ['/about', 'About · Tela'],
      ['/privacy', 'Privacy · Tela'],
      ['/terms', 'Terms · Tela'],
    ] as const) {
      const res = await page.goto(path)
      expect(res?.status()).toBe(200)
      expect(res?.headers()['x-robots-tag']).toBe('noindex, nofollow')
      await expect(page.locator('#tela-data')).toHaveCount(0)
      await expect(page.getByTestId('info-page')).toBeVisible()
      await expect(page.getByTestId('info-short')).toBeVisible()
      await expect(page.getByTestId('info-updated')).toHaveText('Last updated 4 October 2026')
      await expect(page).toHaveTitle(title)
      await expect(
        page.getByTestId('site-footer').getByRole('link', { name: 'Privacy' }),
      ).toHaveAttribute('href', '/privacy')
    }
    // The anchor is in the page the edge sent, so the browser lands on it by itself.
    await page.goto('/privacy#cookies')
    await expect(page.locator('#cookies')).toBeInViewport()
  })
})

test.describe('for a guest', () => {
  test('the tabs move between the pages, and the table of contents between sections', async ({
    page,
  }) => {
    await page.goto('/about')
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(
      'A reader for the independent web.',
    )
    await expect(
      page.getByTestId('info-tabs').getByRole('link', { name: 'About' }),
    ).toHaveAttribute('aria-current', 'page')
    // A guest reads them: nothing sends them to sign in first.
    await page.getByTestId('info-tabs').getByRole('link', { name: 'Privacy' }).click()
    await expect(page).toHaveURL(`${BASE}/privacy`)
    await expect(page).toHaveTitle('Privacy · Tela')
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Privacy')

    await page
      .getByTestId('info-toc')
      .getByRole('link', { name: 'Cookies and your device' })
      .click()
    await expect(page).toHaveURL(`${BASE}/privacy#cookies`)
    await expect(page.locator('#cookies')).toBeInViewport()

    // A link inside the copy to another page's section lands on that section.
    await page.getByTestId('info-tabs').getByRole('link', { name: 'Terms' }).click()
    await expect(page).toHaveURL(`${BASE}/terms`)
    await page.locator('#posts').getByRole('link', { name: 'Privacy page' }).click()
    await expect(page).toHaveURL(`${BASE}/privacy#public`)
    await expect(page.locator('#public')).toBeInViewport()
  })

  test('in Chinese, with the same anchors', async ({ page, context }) => {
    await context.addCookies([{ name: 'tela_locale', value: 'zh-Hans', url: BASE }])
    await page.goto('/terms')
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-Hans')
    await expect(page).toHaveTitle('条款 · Tela')
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('条款')
    await expect(page.getByTestId('info-updated')).toHaveText('最后更新：2026年10月4日')
    await expect(page.getByTestId('info-tabs').getByRole('link', { name: '隐私' })).toBeVisible()

    await page.getByTestId('info-toc').getByRole('link', { name: '作者的作品' }).click()
    await expect(page).toHaveURL(`${BASE}/terms#writers`)
    await expect(page.locator('#writers')).toBeInViewport()

    await page.goto('/privacy#translation')
    await expect(page.locator('#translation')).toBeInViewport()
    await expect(page.locator('#translation')).toContainText('阿里云百炼')
  })
})

test.describe('an address that does not decode', () => {
  test('is a section that is not there: the page stays whole, its anchors working', async ({
    page,
  }) => {
    const errors: Error[] = []
    page.on('pageerror', (err) => errors.push(err))
    for (const path of ['/about', '/terms', '/privacy']) {
      // The app's first question, asked once it has taken the page over from the edge and run
      // the page's own effects.
      const booted = page.waitForResponse((res) => new URL(res.url()).pathname === '/api/v1/me')
      await page.goto(`${path}#%`)
      await booted
      await expect(page.getByTestId('info-page')).toBeVisible()
    }
    await page
      .getByTestId('info-toc')
      .getByRole('link', { name: 'Cookies and your device' })
      .click()
    await expect(page).toHaveURL(`${BASE}/privacy#cookies`)
    await expect(page.locator('#cookies')).toBeInViewport()
    expect(errors).toEqual([])
  })

  test('is no choice of language, in a cookie: the browser decides', async ({ page, context }) => {
    const errors: Error[] = []
    page.on('pageerror', (err) => errors.push(err))
    await context.addCookies([{ name: 'tela_locale', value: '%E4', url: BASE }])
    const booted = page.waitForResponse((res) => new URL(res.url()).pathname === '/api/v1/me')
    const res = await page.goto('/terms')
    expect(res?.status()).toBe(200)
    await booted
    await expect(page.getByTestId('info-page')).toBeVisible()
    await expect(page.locator('html')).toHaveAttribute('lang', 'en')
    expect(errors).toEqual([])
  })

  test('is a profile that is not there', async ({ page }) => {
    const errors: Error[] = []
    page.on('pageerror', (err) => errors.push(err))
    // The edge has no page for it either, so the app says so.
    const res = await page.goto('/@%')
    expect(res?.status()).toBe(200)
    await expect(page.getByTestId('not-found')).toBeVisible()
    expect(errors).toEqual([])
  })
})

import { type APIRequestContext, expect, type Page, test } from '@playwright/test'
import {
  accountMenuOrder,
  BASE,
  expectHeaderFits,
  measureHeader,
  memberHeaders,
  resetReading,
  setPrefs,
} from './helpers'

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

  test('the account menu opens on a phone, and holds the way to Settings', async ({ page }) => {
    await page.goto('/reading')
    await page.getByTestId('account-menu').click()
    const panel = page.getByTestId('account-panel')
    await expect(panel).toBeVisible()
    await page.getByTestId('nav-settings').click()
    await expect(page).toHaveURL(/\/settings$/)
    await expect(panel).toHaveCount(0)
  })
})

/** What the server holds of the member's two languages, through a snapshot pull. */
async function serverLanguages(request: APIRequestContext) {
  const res = await request.get(`${BASE}/api/v1/sync?cursor=0`, {
    headers: await memberHeaders(request),
  })
  const body = (await res.json()) as {
    rows: { profile: { uiLocale: string | null; readingLang: string | null }[] }
  }
  const profile = body.rows.profile[0]
  return profile && { uiLocale: profile.uiLocale, readingLang: profile.readingLang }
}

/** The next push that carries `fragment` (a mutation's field, as JSON), once it is answered. */
function pushed(page: Page, fragment: string) {
  return page.waitForResponse(
    (r) =>
      r.url().includes('/api/v1/mutations') &&
      r.ok() &&
      (r.request().postData() ?? '').includes(fragment),
  )
}

/**
 * The phone's header and account menu (Tela v5, mobile screens 07 and 08): the header is the
 * lockup, the nav and the avatar, and the language, the theme and search are the menu's first
 * rows instead.
 */
test.describe('the phone header and account menu', () => {
  test('the header is the lockup, the nav and the avatar, and the three pills fit', async ({
    page,
  }) => {
    for (const width of [360, 412]) {
      await page.setViewportSize({ width, height: 860 })
      await page.goto('/reading')
      // Following is a member's: measured before it lands, the nav holds two pills, and passes.
      await page.getByTestId('nav-following').waitFor()
      // Neither circle: both are in the page, and out of the phone's budget.
      for (const id of ['language-menu', 'theme-menu', 'search-link']) {
        await expect(page.getByTestId(id)).toHaveCount(1)
        await expect(page.getByTestId(id)).toBeHidden()
      }
      const m = await measureHeader(page, ['account-menu'])
      expectHeaderFits(m, width)
      expect(m.client, `nav is clipped at ${width}px`).toBe(m.scroll)
      expect(m.controls['account-menu']?.width, 'account menu squeezed').toBe(30)
    }
  })

  test('the menu sits 8px from each edge, in the order of Tela v5, every row to touch', async ({
    page,
  }) => {
    await page.goto('/reading')
    await page.getByTestId('account-menu').click()
    const panel = page.getByTestId('account-panel')
    // The profile's row needs the profile: wait for the first pull before reading the order.
    await expect(panel.getByTestId('nav-profile')).toBeVisible()
    // It fades in from 4px lower: measure where it comes to rest.
    await panel.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)))
    const box = await panel.boundingBox()
    const width = page.viewportSize()?.width ?? 0
    expect(box && [Math.round(box.x), Math.round(box.x + box.width), Math.round(box.y)]).toEqual([
      8,
      width - 8,
      64,
    ])
    expect(await panel.evaluate((el) => getComputedStyle(el).borderRadius)).toBe('14px')
    const order = await accountMenuOrder(page)
    // The setup's member has claimed a blog once public.e2e.ts has run in the chromium project.
    const writer = order.includes('nav-dashboard') ? 'nav-dashboard' : 'nav-for-writers'
    expect(order).toEqual([
      'account-language',
      'account-theme-row',
      'account-search',
      'nav-profile',
      'nav-subscriptions',
      writer,
      'nav-settings',
      'nav-invites',
      'sign-out',
    ])
    for (const id of order) {
      const row = await panel.getByTestId(id).boundingBox()
      const least = id === 'account-language' || id === 'account-theme-row' ? 48 : 44
      expect(row && Math.round(row.height), `${id} is too short to touch`).toBeGreaterThanOrEqual(
        least,
      )
    }
    // The device's rows set apart from the menu's, and Sign out from the rest.
    await expect(panel.getByRole('separator')).toHaveCount(2)
    expect(
      await panel.getByTestId('nav-settings').evaluate((el) => getComputedStyle(el).fontSize),
    ).toBe('15px')
  })

  test('the Language row opens the list in place, and sets the language as the circle does', async ({
    page,
  }) => {
    await resetReading(page.request)
    try {
      await page.goto('/reading')
      await page.getByTestId('account-menu').click()
      const panel = page.getByTestId('account-panel')
      const row = panel.getByTestId('account-language')
      await expect(row).toContainText('Language')
      await expect(row).toContainText('English')
      await row.click()
      await expect(panel).toHaveAttribute('data-view', 'language')
      const back = panel.getByTestId('account-language-back')
      await expect(back).toHaveText('Language')
      await expect(back).toBeFocused()
      // The four in their own names and `lang`, the current one ticked on the hover ground.
      const choice = (code: string) => panel.getByTestId(`account-language-${code}`)
      await expect(panel.locator('button[lang]')).toHaveText([
        '简体中文',
        '繁體中文',
        'English',
        'Français',
      ])
      for (const code of ['zh-Hans', 'zh-Hant', 'en', 'fr']) {
        await expect(choice(code)).toHaveAttribute('lang', code)
      }
      await expect(choice('en')).toHaveAttribute('aria-pressed', 'true')
      await expect(choice('en').locator('svg')).toHaveCount(1)
      await expect(choice('en')).toHaveClass(/(^|\s)bg-hover(\s|$)/)
      await expect(choice('fr').locator('svg')).toHaveCount(0)
      await expect(panel).toContainText('Menus and translations follow this choice.')
      await expect(panel.getByTestId('account-language-settings')).toHaveAttribute(
        'href',
        '/settings/translation',
      )
      // Back is the menu again, focus on the row it left.
      await back.click()
      await expect(panel).toHaveAttribute('data-view', 'menu')
      await expect(row).toBeFocused()

      // Linked, a choice is the interface language, as the circle's is, and the menu closes.
      const push = pushed(page, '"uiLocale":"fr"')
      await row.click()
      await choice('fr').click()
      await expect(page.locator('html')).toHaveAttribute('lang', 'fr')
      await expect(panel).toHaveCount(0)
      await push
      expect(await serverLanguages(page.request)).toEqual({ uiLocale: 'fr', readingLang: null })
      await page.getByTestId('account-menu').click()
      await expect(row).toContainText('Langue')
      await expect(row).toContainText('Français')
    } finally {
      await resetReading(page.request)
    }
  })

  test('set apart, the row and its list say Translate into, and change only that', async ({
    page,
  }) => {
    await resetReading(page.request)
    await setPrefs(page.request, {}, { readingLang: 'zh-Hant' })
    try {
      await page.goto('/reading')
      await page.getByTestId('account-menu').click()
      const panel = page.getByTestId('account-panel')
      const row = panel.getByTestId('account-language')
      await expect(row).toContainText('Translate into')
      await expect(row).toContainText('繁體中文')
      await row.click()
      await expect(panel.getByTestId('account-language-back')).toHaveText('Translate into')
      await expect(panel.getByTestId('account-language-zh-Hant')).toHaveAttribute(
        'aria-pressed',
        'true',
      )
      await expect(panel).toContainText('Translations follow this choice')
      const push = pushed(page, '"readingLang":"fr"')
      await panel.getByTestId('account-language-fr').click()
      await push
      // The interface stays as it was, here and on the account.
      await expect(page.locator('html')).toHaveAttribute('lang', 'en')
      expect(await serverLanguages(page.request)).toEqual({ uiLocale: 'en', readingLang: 'fr' })
      await page.getByTestId('account-menu').click()
      await expect(row).toContainText('Français')
    } finally {
      await resetReading(page.request)
    }
  })

  test("the Theme control sets the member's theme, as the header's menu does", async ({ page }) => {
    await resetReading(page.request)
    try {
      await page.emulateMedia({ colorScheme: 'light' })
      await page.goto('/reading')
      await page.getByTestId('account-menu').click()
      const auto = page.getByTestId('account-theme-system')
      await expect(auto).toHaveAttribute('aria-pressed', 'true')
      const dark = page.getByTestId('account-theme-dark')
      await expect(dark).toHaveAttribute('aria-pressed', 'false')
      expect(await dark.evaluate((el) => getComputedStyle(el).fontSize)).toBe('13px')
      const sent = page.waitForRequest(
        (r) => r.url().includes('/api/v1/mutations') && (r.postData() ?? '').includes('ui.theme'),
      )
      await dark.click()
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
      await expect(dark).toHaveAttribute('aria-pressed', 'true')
      // The synced pref, as the header's menu writes it, and the menu stays open on its choice.
      expect(JSON.parse((await sent).postData() ?? '{}').mutations).toContainEqual(
        expect.objectContaining({ type: 'setPref', key: 'ui.theme', value: 'dark' }),
      )
      await expect(page.getByTestId('account-panel')).toBeVisible()
      await auto.click()
      await expect(page.locator('html')).not.toHaveAttribute('data-theme', /./)
      await expect(auto).toHaveAttribute('aria-pressed', 'true')
    } finally {
      await resetReading(page.request)
    }
  })

  test('the Search row reaches search, which the phone header has no room for', async ({
    page,
  }) => {
    await page.goto('/reading')
    await page.getByTestId('account-menu').click()
    await page.getByTestId('account-search').click()
    await expect(page).toHaveURL(/\/search$/)
    await expect(page.getByTestId('account-panel')).toHaveCount(0)
    await expect(page.getByTestId('search-page-input')).toBeVisible()
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

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
    await sub.click()
    await expect(page).toHaveURL(/feed=\d+/)
    await expect(page.getByTestId('mobile-nav')).toContainText('Julia Evans')

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

    // The back bar goes back to the list by its name, in the toolbar's place.
    const back = page.getByTestId('reader-back')
    // The feed's name, as the list's summary says it (the row's text also holds its swatch's
    // initial).
    await expect(back).toContainText('Julia Evans')
    await expect(page.getByTestId('close-article')).toHaveCount(0)
    await back.click()
    await expect(page).not.toHaveURL(/article=/)
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

  test('the Feeds menu: the list on the left, Feeds on the right, and rows a finger can hit', async ({
    page,
  }) => {
    await page.goto('/reading')
    const nav = page.getByTestId('mobile-nav')
    const summary = nav.locator('summary')
    await expect(summary).toContainText('All articles')
    await expect(summary).toContainText('Feeds')
    await summary.click()
    await expect(nav).toHaveAttribute('open', '')
    await page.getByTestId('mobile-subscription').first().waitFor()
    const heights = await nav
      .locator('a[href^="/reading"]')
      .evaluateAll((links) => links.map((a) => a.getBoundingClientRect().height))
    expect(Math.min(...heights), 'a row under 40px').toBeGreaterThanOrEqual(40)
    const gear = await nav.getByTestId('manage-subscriptions').boundingBox()
    expect(gear && { width: Math.round(gear.width), height: Math.round(gear.height) }).toEqual({
      width: 44,
      height: 32,
    })
    // The last row adds a blog.
    await expect(nav.locator('a').last()).toHaveText('+ Add a blog')
    await expect(nav.locator('a').last()).toHaveAttribute('href', '/add')
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

/**
 * The article on a phone (Tela Mobile 03–05): a back bar in place of the toolbar, and a bar of
 * actions fixed at the foot, where a thumb reaches; Recommend opens as a bottom sheet.
 */
test.describe('the article on a phone', () => {
  test.beforeEach(async ({ page }) => {
    // Posts read on opening and read posts listed, whatever an earlier spec left.
    await resetReading(page.request)
  })

  /** Open the second post in All articles, and wait for the bar at its foot. */
  async function openArticle(page: Page) {
    await page.goto('/reading')
    await page.getByTestId('article-row').nth(1).click()
    await expect(page).toHaveURL(/article=\d+/)
    await expect(page.getByTestId('bottom-bar')).toBeVisible()
  }

  /** The next push that carries `fragment`, once it is answered: so no later spec meets it. */
  const pushed = (page: Page, fragment: string) =>
    page.waitForResponse(
      (r) =>
        r.url().includes('/api/v1/mutations') &&
        r.ok() &&
        (r.request().postData() ?? '').includes(fragment),
    )

  test('a back bar in the toolbar’s place goes back to the list', async ({ page }) => {
    await openArticle(page)
    const bar = page.getByTestId('back-bar')
    const back = bar.getByTestId('reader-back')
    expect((await bar.boundingBox())?.height).toBeCloseTo(52, 0)
    await expect(back).toHaveText('All articles')
    await expect(back).toHaveAccessibleName('Back to All articles')
    expect((await back.boundingBox())?.height).toBeGreaterThanOrEqual(44)
    await expect(bar.getByTestId('typography-button')).toBeVisible()
    // The desktop's controls are not drawn: they are in the bars.
    for (const id of [
      'close-article',
      'focus-toggle',
      'like-button',
      'recommend-button',
      'end-like',
      'end-recommend',
    ]) {
      await expect(page.getByTestId(id)).toHaveCount(0)
    }
    // What the author sees is still said at the end.
    await expect(page.getByTestId('end-actions')).toContainText('The author sees')

    // The end of the article clears the bar when scrolled to the foot.
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
    const last = (await page.getByTestId('next-article').count()) ? 'next-article' : 'end-blog'
    const end = await page.getByTestId(last).boundingBox()
    const foot = await page.getByTestId('bottom-bar').boundingBox()
    expect(end && foot && end.y + end.height <= foot.y, 'the end is under the bar').toBe(true)

    await back.click()
    await expect(page).not.toHaveURL(/article=/)
    await expect(page.getByTestId('article-list')).toBeVisible()
    await expect(page.getByTestId('bottom-bar')).toHaveCount(0)
    const variable = await page.evaluate(() =>
      document.documentElement.style.getPropertyValue('--bottom-bar'),
    )
    expect(variable, 'the bar left its height behind').toBe('')
  })

  test('the bottom bar likes the post, and its count follows', async ({ page }) => {
    await openArticle(page)
    const bar = page.getByTestId('bottom-bar')
    const box = await bar.boundingBox()
    const viewport = page.viewportSize()
    expect(box && viewport && Math.round(box.y + box.height)).toBe(viewport?.height)
    const variable = await page.evaluate(() =>
      document.documentElement.style.getPropertyValue('--bottom-bar'),
    )
    expect(variable).toBe(`${Math.round(box?.height ?? 0)}px`)

    const like = page.getByTestId('bar-like')
    expect((await like.boundingBox())?.height).toBeGreaterThanOrEqual(48)
    const was = (await like.getAttribute('aria-pressed')) === 'true'
    const n = Number(/(\d+)$/.exec(((await like.textContent()) ?? '').trim())?.[1])
    expect(Number.isNaN(n)).toBe(false)
    await like.click()
    await expect(like).toHaveAttribute('aria-pressed', String(!was))
    await expect(like).toHaveText(was ? `Like · ${n - 1}` : `Liked · ${n + 1}`)
    const back = pushed(page, `"liked":${was}`)
    await like.click()
    await expect(like).toHaveAttribute('aria-pressed', String(was))
    await expect(like).toHaveText(was ? `Liked · ${n}` : `Like · ${n}`)
    await back
  })

  test('Recommend opens a bottom sheet, which recommends with a note', async ({ page }) => {
    await openArticle(page)
    const recommend = page.getByTestId('bar-recommend')
    if ((await recommend.getAttribute('aria-pressed')) === 'true') await recommend.click()
    await expect(recommend).toHaveText('Recommend')

    // Esc closes the sheet, and only the sheet, and the button has its focus back.
    await recommend.click()
    const sheet = page.getByTestId('recommend-sheet')
    const field = sheet.getByTestId('recommend-note')
    await expect(sheet).toBeVisible()
    await expect(sheet).toHaveAccessibleName('Recommend to your readers')
    await expect(field).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(sheet).toHaveCount(0)
    await expect(page).toHaveURL(/article=\d+/)
    await expect(recommend).toBeFocused()

    // So does a tap on the scrim above it.
    await recommend.click()
    await expect(sheet).toBeVisible()
    await page.mouse.click(200, 60)
    await expect(sheet).toHaveCount(0)

    await recommend.click()
    const title = (await page.getByTestId('article-title').textContent())?.trim() ?? ''
    await expect(sheet).toContainText(title)
    // Cancel beside Recommend, a third and two thirds, both a thumb's height.
    const cancel = await sheet.getByRole('button', { name: 'Cancel' }).boundingBox()
    const submit = await sheet.getByTestId('recommend-submit').boundingBox()
    expect(cancel && submit && cancel.height >= 46 && submit.height >= 46).toBe(true)
    expect(cancel && submit && submit.width > cancel.width * 1.8).toBe(true)

    await field.fill('For the part about the tests.')
    const sent = pushed(page, 'For the part about the tests.')
    await sheet.getByTestId('recommend-submit').click()
    const toast = page.getByTestId('toast')
    await expect(toast).toContainText('Recommended with your note.')
    await expect(sheet).toHaveCount(0)
    await expect(recommend).toHaveAttribute('aria-pressed', 'true')
    await expect(recommend).toHaveText('Recommended')
    // The toast stands clear of the bar.
    const said = await toast.boundingBox()
    const foot = await page.getByTestId('bottom-bar').boundingBox()
    expect(said && foot && said.y + said.height <= foot.y, 'the toast is under the bar').toBe(true)
    await sent

    // Recommended, the same button takes it back.
    const taken = pushed(page, 'unrecommend')
    await recommend.click()
    await expect(toast).toContainText('Recommendation removed.')
    await expect(recommend).toHaveAttribute('aria-pressed', 'false')
    await taken
  })

  test('Mark unread flips, and Original links to the post', async ({ page }) => {
    await openArticle(page)
    // Opening read it, so the bar offers the way back, as the toolbar does on a desktop.
    await expect(page.getByTestId('mark-unread')).toHaveText('Mark unread')
    await page.getByTestId('mark-unread').click()
    await expect(page.getByTestId('mark-read')).toHaveText('Mark read')
    await page.getByTestId('mark-read').click()
    await expect(page.getByTestId('mark-unread')).toBeVisible()

    const href = await page
      .getByTestId('reader')
      .getByRole('link', { name: /Open the original/ })
      .getAttribute('href')
    expect(href).toMatch(/^https?:\/\//)
    const original = page.getByTestId('bar-original')
    await expect(original).toHaveText('Original')
    await expect(original).toHaveAttribute('href', href ?? '')
    await expect(original).toHaveAttribute('target', '_blank')
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

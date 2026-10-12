import { type APIRequestContext, expect, type Page, test } from '@playwright/test'
import {
  ADMIN_TOKEN,
  accountMenuOrder,
  BASE,
  expectHeaderFits,
  FIXTURES,
  measureHeader,
  memberHeaders,
  noSidewaysScroll,
  resetReading,
  restingBox,
  setPrefs,
  signInRequest,
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
    await noSidewaysScroll(page, 'the page')

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

  test("the list's Unread and All, and Mark all read, are a finger's size, as is Show all", async ({
    page,
  }) => {
    await resetReading(page.request)
    await page.goto('/reading')
    await page.getByTestId('mobile-nav').locator('summary').click()
    await page.getByTestId('mobile-subscription').filter({ hasText: '胡涂说' }).first().click()
    await expect(page).toHaveURL(/feed=\d+/)
    await expect(page.getByTestId('unread-dot').first()).toBeVisible()
    const unreadOnly = page.getByTestId('list-show-unread')
    try {
      // Tela Mobile 01: 36px segments, and 44px to touch Mark all read.
      for (const segment of [unreadOnly, page.getByTestId('list-show-all')]) {
        expect((await restingBox(segment)).height).toBeGreaterThanOrEqual(36)
      }
      const markAll = page.getByTestId('mark-all-read')
      expect((await restingBox(markAll)).height).toBeGreaterThanOrEqual(44)
      await noSidewaysScroll(page, 'the list')

      // Tela Mobile 18, held for its Undo and taken back.
      await unreadOnly.click()
      await markAll.click()
      const caughtUp = page.getByTestId('list-caught-up')
      await expect(caughtUp).toBeVisible()
      expect((await restingBox(page.getByTestId('show-all'))).height).toBeGreaterThanOrEqual(44)
      await noSidewaysScroll(page, 'All caught up')
      await page.getByTestId('toast-action').click()
      await expect(caughtUp).toHaveCount(0)
    } finally {
      await resetReading(page.request)
    }
  })

  test("in French at 320px, the switch and Mark all read share the list's row", async ({
    page,
  }) => {
    await resetReading(page.request)
    // The longest Mark all read the catalogues have, on the narrowest phone.
    await setPrefs(page.request, {}, { uiLocale: 'fr' })
    try {
      await page.setViewportSize({ width: 320, height: 640 })
      await page.goto('/reading')
      await expect(page.locator('html')).toHaveAttribute('lang', 'fr')
      await page.getByTestId('mobile-nav').locator('summary').click()
      await page.getByTestId('mobile-subscription').filter({ hasText: '胡涂说' }).first().click()
      await expect(page).toHaveURL(/feed=\d+/)
      const markAll = page.getByTestId('mark-all-read')
      await expect(markAll).toHaveText('Tout marquer comme lu')
      await noSidewaysScroll(page, 'the list in French')
      const [all, mark] = [
        await restingBox(page.getByTestId('list-show-all')),
        await restingBox(markAll),
      ]
      // Side by side, inside the 20px gutter, and still a finger's size.
      expect(mark.x).toBeGreaterThan(all.x + all.width)
      expect(mark.x + mark.width).toBeLessThanOrEqual(300)
      expect(mark.height).toBeGreaterThanOrEqual(44)
    } finally {
      await resetReading(page.request)
    }
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
      .evaluateAll((links) => links.map((a) => Math.round(a.getBoundingClientRect().height)))
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
      // The row went with the panel; focus is on the avatar, not <body>.
      await expect(page.getByTestId('account-menu')).toBeFocused()
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
    // Rounded: inside the pane's fade, its transform puts a 44px box at 43.999996 (CI did).
    expect(Math.round((await back.boundingBox())?.height ?? 0)).toBeGreaterThanOrEqual(44)
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
    expect(Math.round((await like.boundingBox())?.height ?? 0)).toBeGreaterThanOrEqual(48)
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
    expect(
      cancel && submit && Math.round(cancel.height) >= 46 && Math.round(submit.height) >= 46,
    ).toBe(true)
    expect(cancel && submit && submit.width > cancel.width * 1.8).toBe(true)

    await field.fill('For the part about the tests.')
    // The reading page's keys are not the sheet's: j from Cancel neither leaves the article nor
    // loses the note, and m and ? do nothing under it.
    const at = page.url()
    await sheet.getByRole('button', { name: 'Cancel' }).focus()
    for (const key of ['j', 'm', '?']) await page.keyboard.press(key)
    await expect(sheet).toBeVisible()
    await expect(field).toHaveValue('For the part about the tests.')
    expect(page.url()).toBe(at)
    await expect(page.getByTestId('mark-read')).toHaveCount(0)
    await expect(page.getByTestId('shortcuts')).toHaveCount(0)
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

  test('the account menu opens over the bar, and scrolls to its last row on a short screen', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 360, height: 640 })
    await openArticle(page)
    await page.getByTestId('account-menu').click()
    const panel = page.getByTestId('account-panel')
    await expect(panel.getByTestId('nav-profile')).toBeVisible()
    /** Whether a tap at the middle of `id` lands on it, not on the bar's Mark read under it. */
    const reached = (id: string) =>
      panel.getByTestId(id).evaluate((el) => {
        const r = el.getBoundingClientRect()
        const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
        return at !== null && el.contains(at)
      })
    // Upright, then turned on its side, where the panel hangs under the avatar (`sm`) and is
    // taller than the window: it stops 8px above the foot and scrolls.
    for (const size of [
      { width: 360, height: 640 },
      { width: 640, height: 350 },
    ]) {
      await page.setViewportSize(size)
      await expect(page.getByTestId('bottom-bar')).toBeVisible()
      await panel.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)))
      const box = await panel.boundingBox()
      expect(box && box.y + box.height).toBeLessThanOrEqual(size.height - 7)
      for (const id of ['nav-invites', 'sign-out']) {
        await panel.getByTestId(id).scrollIntoViewIfNeeded()
        expect(await reached(id), `${id} at ${size.width}×${size.height}`).toBe(true)
      }
    }
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
      await noSidewaysScroll(page, `Discover's ${tab} tab`)
    }
  })
})

test.describe('the Dashboard on a phone', () => {
  // The setup's member has claimed no blog, so the dashboard's answer is the test's own: a post
  // with notes, one without, and one with no date. The page reads only this answer, never the
  // device's tables, and the route admits any member.
  const DAY = 86_400_000
  const dashboard = {
    sites: [
      {
        id: 999_997,
        title: 'The Long Margin',
        homeUrl: 'https://longmargin.example',
        faviconKey: null,
        listing: 'listed',
        primaryLang: 'en',
        topics: [],
        readerCount: 86,
        newReaders30d: 9,
        translationOptOut: false,
        totals: { posts: 3, likes: 132, recommendations: 38, notes: 4 },
        posts: [
          {
            id: 999_991,
            title: 'Editing is mostly deleting',
            url: 'https://longmargin.example/editing',
            publishedAt: Date.now() - 6 * DAY,
            likeCount: 41,
            recommendCount: 12,
            noteCount: 2,
          },
          {
            id: 999_992,
            title: 'Four languages, two of them badly',
            url: null,
            publishedAt: Date.now() - 14 * DAY,
            likeCount: 63,
            recommendCount: 19,
            noteCount: 0,
          },
          {
            id: 999_993,
            title: 'A reading list for the dark months',
            url: null,
            publishedAt: null,
            likeCount: 28,
            recommendCount: 7,
            noteCount: 2,
          },
        ],
      },
    ],
    notes: [
      {
        note: 'Cut the second paragraph, she says, and she is right about mine too.',
        createdAt: Date.now() - DAY,
        siteId: 999_997,
        articleId: 999_991,
        articleTitle: 'Editing is mostly deleting',
        articleUrl: null,
        handle: 'anna',
        displayName: 'Anna Kowalska',
        avatar: null,
      },
    ],
  }

  test('three tiles abreast under short labels, and the posts as rows', async ({ page }) => {
    // English, whatever an earlier spec left: the labels and dates are read in it.
    await resetReading(page.request)
    await page.route('**/api/v1/dashboard', (route) => route.fulfill({ json: dashboard }))
    for (const width of [360, 412]) {
      await page.setViewportSize({ width, height: 860 })
      await page.goto('/dashboard')
      const rows = page.getByTestId('dashboard-post')
      await expect(rows).toHaveCount(3)
      // Rows in the table's place, not beside a hidden one.
      await expect(page.locator('table')).toHaveCount(0)

      // Each tile keeps its three spans, the label the short one.
      await expect(page.getByTestId('dashboard-readers').locator('span')).toHaveText([
        'Readers',
        '86',
        '+9 in 30 days',
      ])
      await expect(page.getByTestId('dashboard-likes').locator('span')).toHaveText([
        'Likes',
        '132',
        'across 3 posts',
      ])
      await expect(page.getByTestId('dashboard-recommendations').locator('span')).toHaveText([
        'Recs',
        '38',
        '4 with a note',
      ])
      const boxes = await Promise.all(
        ['readers', 'likes', 'recommendations'].map((k) =>
          page.getByTestId(`dashboard-${k}`).boundingBox(),
        ),
      )
      const tops = boxes.map((box) => Math.round(box?.y ?? -1))
      expect(new Set(tops).size, `the tiles on one row at ${width}`).toBe(1)
      expect(tops[0]).toBeGreaterThanOrEqual(0)
      const last = boxes[2]
      expect(last && last.x + last.width).toBeLessThanOrEqual(width)

      // The date, then the counts with their numbers bold; notes only when there are some, and
      // no date (nor its separator) for a post without one.
      const stats = rows.getByTestId('dashboard-post-stats')
      await expect(stats.nth(0)).toHaveText(/^[^·]+ · 41 likes · 12 recommendations · 2 notes$/)
      await expect(stats.nth(0).locator('b')).toHaveText(['41', '12'])
      await expect(stats.nth(1)).toHaveText(/^[^·]+ · 63 likes · 19 recommendations$/)
      await expect(stats.nth(1)).not.toContainText('note')
      await expect(stats.nth(2)).toHaveText('28 likes · 7 recommendations · 2 notes')

      // What readers said: the note beside a 28px avatar, its date kept.
      const notes = page.getByTestId('dashboard-notes')
      await expect(notes).toContainText('“Cut the second paragraph')
      const avatar = await notes.locator('[data-avatar]').boundingBox()
      expect(avatar && Math.round(avatar.width)).toBe(28)

      await noSidewaysScroll(page, `/dashboard at ${width}px`)
    }
  })
})

/**
 * Following, a profile and a blog page on a phone (Tela Mobile 10–12): the desktop pages resized
 * below md, the profile's and the blog's by CSS alone, since the edge renders them.
 */
test.describe('Following, a profile and a blog page on a phone', () => {
  test('Following: a 36px avatar column, and a card without its footer', async ({ page }) => {
    // Whom the setup's member follows depends on the specs before this one: the feed is given.
    const at = Date.now() - 3_600_000
    const article = {
      id: 990_001,
      feedId: 990_001,
      url: 'https://kilometrocero.example/bakery',
      title: 'The bakery that outlived three metro lines',
      author: null,
      publishedAt: at,
      fetchedAt: at,
      sortAt: at,
      sourceLang: 'en',
      excerpt: 'On Calle de Toledo there is a bakery that has been open since 1928.',
      contentKey: null,
      wordCount: 1200,
      readingMinutes: 6,
      extractState: 'done',
      likeCount: 3,
      recommendCount: 1,
      seq: 1,
    }
    const post = {
      siteId: 990_001,
      siteTitle: 'Kilómetro Cero',
      homeUrl: 'https://kilometrocero.example/',
      listed: true,
      translatedTitle: null,
      translatedExcerpt: null,
      article,
    }
    const person = { id: 'mobile-anna', handle: 'anna_mobile', displayName: 'Anna', avatar: null }
    const items = [
      { kind: 'recommended', key: 'r:mobile', at, person, note: 'The last line is perfect.', post },
      { kind: 'liked', key: 'l:mobile', at, person, count: 1, posts: [post] },
    ]
    await page.route(/\/api\/v1\/following(\?|$)/, (route) =>
      route.fulfill({ json: { items, next: null } }),
    )
    for (const width of [360, 412]) {
      await page.setViewportSize({ width, height: 860 })
      await page.goto('/following')
      const rows = page.getByTestId('following-item')
      await expect(rows).toHaveCount(2)
      // A liked row takes the same column as a recommended one.
      for (const row of await rows.all()) {
        const columns = await row.evaluate((el) => getComputedStyle(el).gridTemplateColumns)
        expect(columns.split(' ')[0], `the avatar column at ${width}px`).toBe('36px')
        expect((await restingBox(row.locator('[data-avatar]').first())).width).toBe(36)
      }
      // The card drops its minutes, heart and "Read →", and is still one link.
      const card = page.getByTestId('following-card')
      await expect(card).toContainText(article.title)
      await expect(card.getByTestId('following-card-foot')).toBeHidden()
      await expect(card.getByRole('link')).toHaveCount(1)
      // Following's own aside stays, below the feed.
      await expect(page.getByTestId('people-you-follow')).toBeVisible()
      await noSidewaysScroll(page, `/following at ${width}px`)
    }
  })

  test('Your profile: a 72px avatar beside Edit profile, which opens Profile in Settings', async ({
    page,
  }) => {
    const me = await page.request.get(`${BASE}/api/v1/me`)
    const handle = ((await me.json()) as { profile: { handle: string } | null }).profile?.handle
    if (!handle) throw new Error('the setup member has no handle')
    for (const width of [360, 412]) {
      await page.setViewportSize({ width, height: 860 })
      await page.goto(`/@${handle}`)
      const edit = page.getByTestId('edit-profile')
      await expect(edit).toBeVisible()
      await expect(edit).toHaveAttribute('href', '/settings/profile')
      const header = page.getByTestId('profile-page').locator('header')
      const avatar = await restingBox(header.locator('[data-avatar]'))
      expect([avatar.width, avatar.height]).toEqual([72, 72])
      // One row: the pill level with the avatar's top, after it, a finger's height.
      const pill = await restingBox(edit)
      expect(pill.y, 'Edit profile is not on the avatar’s row').toBe(avatar.y)
      expect(pill.x).toBeGreaterThan(avatar.x + avatar.width)
      expect(pill.height).toBeGreaterThanOrEqual(40)
      // The name runs full width under them.
      expect((await restingBox(header.locator('h1'))).y).toBeGreaterThanOrEqual(
        avatar.y + avatar.height,
      )
      await noSidewaysScroll(page, `/@${handle} at ${width}px`)
    }
  })

  test('A blog page: Visit and Subscribe share a row at equal width', async ({ page }) => {
    // A blog nobody claimed has no public page; an operator featuring it gives it one.
    const curated = await page.request.post(`${BASE}/api/admin/curate`, {
      headers: { origin: BASE, authorization: `Bearer ${ADMIN_TOKEN}` },
      data: { feedUrl: `${FIXTURES}/jvns.xml`, topics: [], featured: true },
    })
    expect(curated.ok()).toBe(true)
    const { siteId } = (await curated.json()) as { siteId: number }
    for (const width of [360, 412]) {
      await page.setViewportSize({ width, height: 860 })
      await page.goto(`/s/${siteId}`)
      await expect(page.getByTestId('site-subscribe')).toBeVisible()
      const visit = await restingBox(page.getByTestId('site-visit'))
      const subscribe = await restingBox(page.getByTestId('site-subscribe'))
      expect(visit.y, 'Visit and Subscribe are not on one row').toBe(subscribe.y)
      expect(Math.abs(visit.width - subscribe.width), 'unequal widths').toBeLessThanOrEqual(1)
      expect(visit.height).toBeGreaterThanOrEqual(40)
      expect(subscribe.height).toBeGreaterThanOrEqual(40)
      await noSidewaysScroll(page, `/s/${siteId} at ${width}px`)
    }
  })
})

/**
 * Settings on a phone (Tela Mobile 13): `/settings` lists the sections, each a page of its own
 * behind a back bar to the list, and a setting's control sits beside its label where it fits.
 */
test.describe('Settings on a phone', () => {
  test.beforeEach(async ({ page }) => {
    // English, whatever an earlier spec left: the rows are checked by name.
    await resetReading(page.request)
  })

  const SECTIONS = [
    ['profile', 'Profile'],
    ['reading', 'Reading'],
    ['translation', 'Language'],
    ['subscriptions', 'Subscriptions'],
    ['privacy', 'Privacy'],
    ['invites', 'Invites'],
    ['account', 'Account'],
  ] as const

  /** A section's name, the heading of its page. */
  const title = (page: Page) =>
    page.getByTestId('settings-content').getByRole('heading', { level: 1 })

  test('the list holds the seven sections, rows to touch that each open their own page', async ({
    page,
  }) => {
    for (const width of [360, 412]) {
      await page.setViewportSize({ width, height: 860 })
      await page.goto('/settings')
      await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible()
      const rows = page.getByTestId(/^settings-section-/)
      await expect(rows).toHaveCount(SECTIONS.length)
      // The list, not Profile beside it.
      await expect(page.getByTestId('settings-content')).toHaveCount(0)
      for (const [i, [section, name]] of SECTIONS.entries()) {
        const row = rows.nth(i)
        await expect(row).toHaveAttribute('data-testid', `settings-section-${section}`)
        await expect(row).toHaveText(name)
        await expect(row).toHaveAttribute('href', `/settings/${section}`)
        const box = await row.boundingBox()
        expect(Math.round(box?.height ?? 0), `${section} at ${width}px`).toBeGreaterThanOrEqual(48)
      }
      let entries: number | null = null
      for (const [section, name] of SECTIONS) {
        await page.getByTestId(`settings-section-${section}`).click()
        await expect(page).toHaveURL(new RegExp(`/settings/${section}$`))
        await expect(page.getByTestId('settings-content')).toHaveAttribute('data-section', section)
        // Its name is the page's heading, and has focus, as a new page's would.
        await expect(title(page)).toHaveText(name)
        await expect(title(page)).toBeFocused()
        await page.getByTestId('settings-back').click()
        await expect(page).toHaveURL(/\/settings$/)
        await expect(rows).toHaveCount(SECTIONS.length)
        // Back to where the member was: the row they left by has focus.
        await expect(page.getByTestId(`settings-section-${section}`)).toBeFocused()
        // The bar went back, not on: seven sections visited leave the history as one went in,
        // the list and one section ahead of it, not a list between each.
        const now = await page.evaluate(() => history.length)
        entries ??= now
        expect(now, `history after ${section} at ${width}px`).toBe(entries)
      }
    }
  })

  test('a section reached by its address has the back bar, a link to the list', async ({
    page,
  }) => {
    await page.goto('/settings/subscriptions')
    await expect(page.getByTestId('settings-subscription').first()).toBeVisible()
    const bar = page.getByTestId('settings-back-bar')
    // Rounded: the page fades in on a transform, which can put a 52px box at 51.99.
    expect((await bar.boundingBox())?.height).toBeCloseTo(52, 0)
    const back = bar.getByTestId('settings-back')
    await expect(back).toHaveText('Settings')
    await expect(back).toHaveAccessibleName('Back to Settings')
    await expect(back).toHaveAttribute('href', '/settings')
    expect(Math.round((await back.boundingBox())?.height ?? 0)).toBeGreaterThanOrEqual(44)
    await expect(title(page)).toHaveText('Subscriptions')
    // Loaded, not navigated to: focus is where the browser puts it on any page it loads.
    await expect(title(page)).not.toBeFocused()
    // No list behind it in the history, and the link goes there all the same, to its top.
    await back.click()
    await expect(page).toHaveURL(/\/settings$/)
    await expect(page.getByTestId(/^settings-section-/)).toHaveCount(SECTIONS.length)
    await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeFocused()
  })

  test('a list turned wide and narrow again is still the list the back bar goes back to', async ({
    page,
  }) => {
    // Found by Codex's review: beside the side column the list's entry is handed to Profile, and
    // the back bar, trusting the section's "from the list", went back to Profile.
    await page.setViewportSize({ width: 412, height: 860 })
    await page.goto('/settings')
    await page.getByTestId('settings-section-reading').click()
    await expect(page).toHaveURL(/\/settings\/reading$/)
    await page.setViewportSize({ width: 1024, height: 860 })
    await page.goBack()
    await expect(page).toHaveURL(/\/settings\/profile$/)
    // Narrowed where it stands, Profile stays: a form being edited there is not swapped away.
    await page.setViewportSize({ width: 412, height: 860 })
    await expect(page.getByTestId('settings-form')).toBeVisible()
    await page.goForward()
    await expect(page).toHaveURL(/\/settings\/reading$/)
    await page.getByTestId('settings-back').click()
    await expect(page).toHaveURL(/\/settings$/)
    await expect(page.getByTestId(/^settings-section-/)).toHaveCount(SECTIONS.length)
    await expect(page.getByTestId('settings-section-reading')).toBeFocused()
  })

  test('a row pressed as the window widens leaves its section where it opened', async ({
    page,
  }) => {
    // Found by Codex's review: React Router moves the location in a transition, and widening
    // renders at once, so the list could render wide at its old address while the row's section
    // was already the browser's entry, and its hand-over to Profile replaced that entry instead.
    // A slowed renderer holds the transition open for the widening to land inside it.
    await page.setViewportSize({ width: 412, height: 860 })
    await page.goto('/settings')
    await expect(page.getByTestId('settings-section-reading')).toBeVisible()
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 30 })
    try {
      await page.getByTestId('settings-section-reading').click()
      await page.setViewportSize({ width: 1024, height: 860 })
    } finally {
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 })
    }
    await expect(page.getByTestId('settings-content')).toHaveAttribute('data-section', 'reading')
    await expect(page).toHaveURL(/\/settings\/reading$/)
    // And the entry behind it is still the list's, which a phone shows as the list.
    await page.setViewportSize({ width: 412, height: 860 })
    await page.goBack()
    await expect(page).toHaveURL(/\/settings$/)
    await expect(page.getByTestId(/^settings-section-/)).toHaveCount(SECTIONS.length)
  })

  test('the back bar opened with a key held is a link, for another tab', async ({ page }) => {
    // Found by Codex's review: the bar went back in this tab whatever the click asked for.
    await page.goto('/settings')
    await page.getByTestId('settings-section-reading').click()
    await expect(page).toHaveURL(/\/settings\/reading$/)
    const opened = page.context().waitForEvent('page')
    await page.getByTestId('settings-back').click({ modifiers: ['ControlOrMeta'] })
    const other = await opened
    await expect(other).toHaveURL(/\/settings$/)
    await other.close()
    // This tab stays where it was.
    await expect(page).toHaveURL(/\/settings\/reading$/)
    await expect(title(page)).toHaveText('Reading')
  })

  test("Reading's three choices sit beside their labels at 360px", async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 800 })
    await page.goto('/settings/reading')
    await expect(page.getByTestId('theme-system')).toBeVisible()
    // Measured in Figtree, as a reader sees them, not in the fallback before it loads.
    await page.evaluate(async () => {
      await document.fonts.ready
    })
    for (const id of ['size-m', 'measure-normal', 'theme-system']) {
      // The label is the row's first item and the control its second: beside it, the control
      // starts after the label ends and before its last line does; wrapped, it is under it.
      const at = await page.getByTestId(id).evaluate((button) => {
        const control = button.closest('fieldset')
        const label = control?.parentElement?.firstElementChild
        if (!control || !label) return null
        const c = control.getBoundingClientRect()
        const l = label.getBoundingClientRect()
        return { left: c.left, top: c.top, labelRight: l.right, labelBottom: l.bottom }
      })
      expect(at, `${id} is not in a row`).not.toBeNull()
      expect(at!.left, `${id} is under its label`).toBeGreaterThanOrEqual(at!.labelRight)
      expect(at!.top, `${id} is on a line of its own`).toBeLessThan(at!.labelBottom)
    }
  })

  test('Profile has an address of its own, which shows the form', async ({ page }) => {
    await page.goto('/settings/profile')
    await expect(page).toHaveURL(/\/settings\/profile$/)
    await expect(page.getByTestId('settings-form')).toBeVisible()
    await expect(title(page)).toHaveText('Profile')
    await expect(page.getByTestId('settings-back')).toBeVisible()
  })

  test('no page of Settings scrolls sideways', async ({ page }) => {
    // What each page shows once its rows are in: the device's, or tela-api's live answer.
    const shown: Record<string, string> = {
      '/settings': 'settings-section-account',
      '/settings/profile': 'settings-form',
      '/settings/reading': 'theme-system',
      '/settings/translation': 'never-add',
      '/settings/subscriptions': 'settings-subscription',
      '/settings/privacy': 'privacy-likes',
      '/settings/account': 'account-email',
      '/settings/invites': 'invite-create',
    }
    for (const width of [360, 412]) {
      await page.setViewportSize({ width, height: 860 })
      for (const [path, id] of Object.entries(shown)) {
        await page.goto(path)
        await expect(page.getByTestId(id).first()).toBeVisible()
        if (path === '/settings/invites') {
          await expect(page.getByTestId('invites-left')).not.toBeEmpty()
        }
        await page.evaluate(async () => {
          await document.fonts.ready
        })
        await noSidewaysScroll(page, `${path} at ${width}px`)
      }
    }
  })
})

/**
 * Search and the first run on a phone (Tela Mobile 15 and 16): the field above what it found,
 * with a clear button of its own, and blogs as rows; the first run's blogs as rows too, with
 * Start in a bar fixed at the foot.
 */
test.describe('Search and the first run on a phone', () => {
  // The fixture site took its description from the Chinese blog ("胡涂说博客/好奇心周刊"), and two
  // of that blog's posts are issues of the weekly: one word finds a blog, and posts read in English
  // with the original beneath.
  const WORD = '好奇心周刊'

  for (const width of [360, 412]) {
    test(`at ${width}px the field comes first, clears in place, and blogs are rows`, async ({
      page,
    }) => {
      // English, and nothing left untranslated, whatever an earlier spec left.
      await resetReading(page.request)
      await page.setViewportSize({ width, height: 800 })
      await page.goto(`/search?q=${encodeURIComponent(WORD)}`)
      const field = page.getByTestId('search-page-input')
      const row = page.getByTestId('search-sites').getByTestId('site-card').first()
      const hit = page.getByTestId('article-hit').filter({ hasText: WORD }).first()
      await expect(row).toBeVisible()
      await expect(hit).toBeVisible()
      await noSidewaysScroll(page, 'the page')

      // The field, then what it searched for.
      const above = await field.boundingBox()
      const heading = await page.getByRole('heading', { level: 1 }).boundingBox()
      expect(above && heading && above.y + above.height <= heading.y).toBe(true)

      // Each line of a hit says its language: the title in the reading language, the original
      // beneath it in the blog's.
      await expect(hit.getByTestId('hit-title')).toHaveAttribute('lang', 'en')
      await expect(hit.getByTestId('hit-secondary')).toHaveAttribute('lang', /^zh/)

      // The clear button: a 44px target that leaves the pill no taller. It empties the field and
      // keeps it focused, and searches nothing: the address and the results stay.
      const pill = page.locator('form').filter({ has: field })
      const clear = page.getByTestId('search-page-input-clear')
      await expect(field).toHaveValue(WORD)
      await expect(clear).toHaveAccessibleName('Clear search')
      const target = await clear.boundingBox()
      expect(target && [Math.round(target.width), Math.round(target.height)]).toEqual([44, 44])
      const tall = (await pill.boundingBox())?.height
      await clear.click()
      await expect(field).toHaveValue('')
      await expect(field).toBeFocused()
      await expect(clear).toHaveCount(0)
      expect((await pill.boundingBox())?.height).toBe(tall)
      expect(new URL(page.url()).searchParams.get('q')).toBe(WORD)
      await expect(row).toBeVisible()

      // A row, not Discover's card: one line of blog, Subscribe at its end.
      const box = await row.boundingBox()
      expect(Math.round(box?.height ?? 0), 'a card, not a row').toBeLessThanOrEqual(80)
      const button = row.getByTestId('site-subscribe')
      const was = (await button.getAttribute('aria-pressed')) === 'true'
      await button.click()
      await expect(button).toHaveAttribute('aria-pressed', String(!was))
      await expect(button).toHaveText(was ? 'Subscribe' : 'Subscribed')
      // And back, once the server has it, so later specs keep the member's feeds.
      const restored = pushed(page, was ? '"type":"subscribe"' : '"type":"unsubscribe"')
      await button.click()
      await expect(button).toHaveAttribute('aria-pressed', String(was))
      await restored
    })
  }

  test.describe('the first run', () => {
    test.use({
      storageState: { cookies: [], origins: [] },
      // A sign-in of its own, from an address of its own: better-auth allows three tries a minute
      // per address, and the whole suite comes from 127.0.0.1 (signin.e2e.ts).
      extraHTTPHeaders: { 'cf-connecting-ip': '198.51.100.62' },
    })

    test('blogs are rows, and Start is a bar at the foot that the page clears', async ({
      page,
      context,
    }) => {
      // A blog Discover lists, whatever ran before, as signin.e2e.ts's first run makes sure.
      const curated = await context.request.post(`${BASE}/api/admin/curate`, {
        headers: { origin: BASE, authorization: `Bearer ${ADMIN_TOKEN}` },
        data: { feedUrl: `${FIXTURES}/jvns.xml`, topics: ['tech'], featured: true },
      })
      expect(curated.ok()).toBe(true)
      await signInRequest(context.request, `phone-first-run-${Date.now()}@e2e.test`)
      await page.goto('/reading')

      const firstRun = page.getByTestId('first-run')
      await expect(firstRun.getByRole('heading', { level: 1 })).toHaveText('Start with a few blogs')
      // The Feeds menu stays above it: on a phone it is the only way to Liked.
      await expect(page.getByTestId('mobile-nav')).toBeVisible()
      const rows = page.getByTestId('first-run-card')
      await expect(rows.first()).toBeVisible()
      const viewport = page.viewportSize()
      const box = await rows.first().boundingBox()
      expect(Math.round(box?.height ?? 0), 'a card, not a row').toBeLessThanOrEqual(80)
      expect(Math.abs((box?.width ?? 0) - ((viewport?.width ?? 0) - 40))).toBeLessThanOrEqual(1)
      await noSidewaysScroll(page, 'the page')

      // Until one is taken, the bar says what it waits for.
      const bar = page.getByTestId('first-run-bar')
      await expect(bar).toHaveText('Subscribe to at least one to start reading.')
      await expect(page.getByTestId('first-run-start')).toHaveCount(0)

      const subscribe = rows.first().getByTestId('first-run-subscribe')
      await expect(subscribe).toHaveText('Subscribe')
      await subscribe.click()
      await expect(subscribe).toHaveAttribute('aria-pressed', 'true')
      await expect(subscribe).toHaveText('Subscribed')
      const start = bar.getByTestId('first-run-start')
      await expect(start).toHaveText('Start reading 1 blog →')
      // In the body, not the page, whose fade-in transform would hold a fixed bar to it.
      await expect(firstRun.getByTestId('first-run-start')).toHaveCount(0)
      expect(Math.round((await start.boundingBox())?.height ?? 0)).toBeGreaterThanOrEqual(48)

      // At the viewport's foot, with its height in --bottom-bar.
      const foot = await bar.boundingBox()
      expect(foot && viewport && Math.round(foot.y + foot.height)).toBe(viewport?.height)
      const variable = await page.evaluate(() =>
        document.documentElement.style.getPropertyValue('--bottom-bar'),
      )
      expect(variable).toBe(`${Math.round(foot?.height ?? 0)}px`)

      // Scrolled to the end, the page's last line clears the bar.
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
      const last = await page.getByTestId('first-run-footer').boundingBox()
      const top = await bar.boundingBox()
      expect(last && top && last.y + last.height <= top.y, 'the footer is under the bar').toBe(true)
      await noSidewaysScroll(page, 'the page')

      await start.click()
      await expect(firstRun).toHaveCount(0)
      await expect(bar).toHaveCount(0)
      await expect(page.getByTestId('article-list')).toBeVisible()
      const left = await page.evaluate(() =>
        document.documentElement.style.getPropertyValue('--bottom-bar'),
      )
      expect(left, 'the bar left its height behind').toBe('')
    })
  })
})

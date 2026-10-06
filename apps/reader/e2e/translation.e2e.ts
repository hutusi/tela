/**
 * Translation in the reader (ADR 0023): titles eagerly by the sweeps, bodies on open, streamed in
 * chunks and laid over the original. The mock provider prefixes "en:" and drops a block marked
 * [[drop]], which is how a provider omitting an entry looks.
 */
import { type APIRequestContext, expect, type Page, test } from '@playwright/test'
import {
  BASE,
  ensureFeeds,
  FIXTURES,
  heldOnDevice,
  keepCycling,
  memberHeaders,
  resetReading,
  setPrefs,
  synced,
} from './helpers'

/** The member's two languages as the server has them, through a snapshot pull. */
async function serverLanguages(
  request: APIRequestContext,
): Promise<{ uiLocale: string | null; readingLang: string | null } | undefined> {
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

test.beforeAll(async () => {
  // A Japanese blog, whose titles the setup's sweeps have not seen yet.
  await ensureFeeds(['/jnito.xml'])
})

// Every spec here reads in English, side by side, at the default size and theme.
test.beforeEach(async ({ page }) => {
  await resetReading(page.request)
})

test.describe('translation', () => {
  test('foreign articles show translated titles and open with a side-by-side translation', async ({
    page,
  }) => {
    await page.goto('/reading')
    await synced(page)
    const row = page.getByTestId('article-row').filter({ hasText: 'JA → EN' }).first()
    await expect(row).toBeVisible()
    await expect(row.locator('h2')).toContainText('en:')

    await row.click()
    const bar = page.getByTestId('translation-bar')
    await expect(bar).toBeVisible()
    await expect(bar).toContainText('Written in Japanese')
    await expect(bar).toHaveAttribute('data-state', /done|partial/, { timeout: 30_000 })
    // Side by side is a grid of paired blocks: one cell per top-level block per side.
    const translated = page.getByTestId('body-translated')
    const original = page.getByTestId('body-original')
    await expect(translated.first()).toContainText('en:')
    await expect(original.first()).toBeVisible()
    expect(await translated.count()).toBeGreaterThan(1)
    expect(await original.count()).toBe(await translated.count())
    await expect(page.getByTestId('article-title')).toContainText('en:')

    await page.getByTestId('mode-trans').click()
    await expect(page.getByTestId('reader')).toHaveAttribute('data-mode', 'trans')
    await expect(page.getByTestId('body-original')).toHaveCount(0)
    await expect(page.locator('.article-body')).toHaveCount(1)
    await page.getByTestId('mode-orig').click()
    await expect(page.getByTestId('body-translated')).toHaveCount(0)
    await expect(page.getByTestId('article-title')).not.toContainText('en:')
    await expect(page).toHaveURL(/mode=orig/)

    // Mode is URL state: closing and going back restores the same view.
    await page.getByTestId('close-article').click()
    await expect(page).not.toHaveURL(/article=/)
    await page.goBack()
    await expect(page).toHaveURL(/article=\d+.*mode=orig/)
    await expect(page.getByTestId('reader')).toHaveAttribute('data-mode', 'orig')
    await expect(page.getByTestId('body-original').first()).toBeVisible()
    await expect(page.getByTestId('body-translated')).toHaveCount(0)
    await page.getByTestId('mode-side').click()
  })

  test('translating only when asked opens the original, and asks for nothing until Translate', async ({
    page,
  }) => {
    await setPrefs(page.request, { 'translate.auto': false })
    const asked: string[] = []
    page.on('request', (r) => {
      if (r.method() === 'POST' && r.url().includes('/api/v1/translations')) asked.push(r.url())
    })
    await page.goto('/reading')
    await synced(page)
    const row = page.getByTestId('article-row').filter({ hasText: 'JA → EN' }).last()
    await row.click()
    const bar = page.getByTestId('translation-bar')
    await expect(bar).toContainText('Written in Japanese.')
    await expect(page.getByTestId('reader')).toHaveAttribute('data-mode', 'orig')
    await expect(page.getByTestId('mode-side')).toHaveCount(0)
    expect(asked).toEqual([])

    const stop = keepCycling(page)
    try {
      await page.getByTestId('translate-now').click()
      await expect(page.getByTestId('mode-side')).toBeVisible()
      await expect(page.getByTestId('reader')).toHaveAttribute('data-mode', 'side', {
        timeout: 30_000,
      })
    } finally {
      stop()
    }
  })

  test('a language never translated reads as written, titles and all', async ({ page }) => {
    await setPrefs(page.request, { 'translate.never': ['ja'] })
    await page.goto('/reading')
    await synced(page)
    await expect(page.getByTestId('article-row').first()).toBeVisible()
    await expect(page.getByTestId('article-row').filter({ hasText: 'JA → EN' })).toHaveCount(0)
    const row = page.getByTestId('article-row').filter({ hasText: 'give IT a try' }).first()
    await expect(row.locator('h2')).not.toContainText('en:')
    await row.click()
    await expect(page.getByTestId('article-title')).not.toContainText('en:')
    await expect(page.getByTestId('translation-bar')).toHaveCount(0)
  })

  test('a finished translation opens from the device the second time', async ({ page }) => {
    await page.goto('/reading')
    await synced(page)
    const row = page.getByTestId('article-row').filter({ hasText: 'JA → EN' }).first()
    await row.click()
    await expect(page.getByTestId('translation-bar')).toHaveAttribute(
      'data-state',
      /done|partial/,
      {
        timeout: 30_000,
      },
    )
    // The bar says done from the synced row; the object itself may still be on its way. Wait
    // until the device holds it, so the second open is from the device by construction.
    const id = Number(/article=(\d+)/.exec((await row.getAttribute('href')) ?? '')?.[1])
    await expect.poll(() => heldOnDevice(page, [id], 'en'), { timeout: 30_000 }).toEqual([id])
    await page.getByTestId('close-article').click()

    // The idle prefetcher may still be filling the device with other posts, their bodies in
    // bundles and their finished translations one at a time; its requests say so. Opening this
    // one must fetch nothing itself.
    const asked: string[] = []
    page.on('request', (r) => {
      const path = new URL(r.url()).pathname
      if (r.headers()['x-tela-prefetch']) return
      if (path.startsWith('/api/v1/translations') || path.startsWith('/o/')) asked.push(path)
    })
    await row.click()
    await expect(page.getByTestId('body-translated').first()).toContainText('en:')
    expect(asked).toEqual([])
  })

  test('switching the language changes what gets translated', async ({ page }) => {
    await page.goto('/reading')
    await synced(page)
    const menu = page.getByTestId('language-menu')
    await menu.locator('summary').click()
    await menu.getByRole('button', { name: '简体中文' }).click()
    // Linked, as an account is by default: the interface goes to Chinese, and the translation
    // follows it.
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-Hans')
    await expect(menu.locator('summary')).toHaveAccessibleName('语言：简体中文')
    await expect(menu.getByTestId('language-menu-zh-Hans')).toHaveAttribute('aria-pressed', 'true')
    // An English feed is now foreign; its titles in Chinese come from the next sweep.
    await page.getByTestId('subscription').filter({ hasText: 'Julia Evans' }).click()
    const stop = keepCycling(page)
    try {
      await expect(page.getByTestId('article-row').first()).toContainText('EN → ZH', {
        timeout: 30_000,
      })
    } finally {
      stop()
    }
    const back = pushed(page, '"uiLocale":"en"')
    await menu.locator('summary').click()
    await menu.getByRole('button', { name: 'English' }).click()
    await expect(page.locator('html')).toHaveAttribute('lang', 'en')
    await expect(page.getByTestId('article-row').first()).not.toContainText('EN → ZH')
    await back
  })

  /**
   * Four languages do not fit in view, so the language circle is a menu: the circle shows the one
   * chosen, short, and the list names each in full, in its own script and `lang`. Linked, as an
   * account is until Settings sets them apart, a choice is the interface language, pushed and
   * kept, and the translation follows it because the account holds none of its own (ADR 0040).
   */
  test('linked, the circle offers four languages in their own names, and sets both', async ({
    page,
  }) => {
    try {
      await page.goto('/reading')
      await synced(page)
      const menu = page.getByTestId('language-menu')
      const summary = menu.locator('summary')
      const choice = (code: string) => menu.getByTestId(`language-menu-${code}`)
      await expect(summary).toHaveAccessibleName('Language: English')
      // What the circle shows is a glyph for it; its name says it in full.
      const glyph = summary.locator('[aria-hidden="true"]')
      await expect(glyph).toHaveText('EN')
      await summary.click()
      await expect(menu.getByRole('button')).toHaveText([
        '简体中文',
        '繁體中文',
        'English',
        'Français',
      ])
      for (const code of ['zh-Hans', 'zh-Hant', 'en', 'fr']) {
        await expect(choice(code)).toHaveAttribute('lang', code)
      }
      await expect(choice('en')).toHaveAttribute('aria-pressed', 'true')
      // Linked, it is the language, not "Translate into"; Settings is still where to set them apart.
      await expect(menu.getByTestId('language-menu-title')).toHaveCount(0)
      await expect(menu.getByTestId('language-menu-settings')).toHaveAttribute(
        'href',
        '/settings/translation',
      )

      // Traditional is a language of its own, not Chinese read another way.
      let push = pushed(page, '"uiLocale":"zh-Hant"')
      await choice('zh-Hant').click()
      await expect(choice('zh-Hant')).toBeHidden()
      await expect(page.locator('html')).toHaveAttribute('lang', 'zh-Hant')
      await expect(page.getByTestId('nav-reading')).toHaveText('閱讀')
      await expect(summary).toHaveAccessibleName('語言：繁體中文')
      await expect(glyph).toHaveText('繁')
      await push
      // The interface is the account's now, and the translation still follows it.
      expect(await serverLanguages(page.request)).toEqual({
        uiLocale: 'zh-Hant',
        readingLang: null,
      })

      push = pushed(page, '"uiLocale":"fr"')
      await summary.click()
      await expect(choice('zh-Hant')).toHaveAttribute('aria-pressed', 'true')
      await choice('fr').click()
      await expect(page.locator('html')).toHaveAttribute('lang', 'fr')
      await expect(summary).toHaveAccessibleName(/^Langue\s: Français$/)
      await push
      expect(await serverLanguages(page.request)).toEqual({ uiLocale: 'fr', readingLang: null })

      // Kept, so the next visit opens in it; one choice is marked, and Esc gives focus back.
      await page.reload()
      await expect(page.locator('html')).toHaveAttribute('lang', 'fr')
      await expect(summary).toHaveAccessibleName(/^Langue\s: Français$/)
      await summary.click()
      await expect(choice('fr')).toHaveAttribute('aria-pressed', 'true')
      await expect(menu.locator('[aria-pressed="true"]')).toHaveCount(1)
      await page.keyboard.press('Escape')
      await expect(choice('fr')).toBeHidden()
      await expect(summary).toBeFocused()
    } finally {
      // Every spec signs in as this member: no other one should meet French.
      await resetReading(page.request)
    }
  })

  /**
   * A member who chose a translation language of their own in Settings has set the two apart:
   * the circle then changes only the translation, and says so, in its name and as its title, with
   * the way back to Settings, where "Same as interface language" links them again.
   */
  test('set apart in Settings, the circle changes only the translation, and says so', async ({
    page,
  }) => {
    try {
      await page.goto('/settings/translation')
      const menu = page.getByTestId('language-menu')
      const summary = menu.locator('summary')
      await expect(summary).toHaveAccessibleName('Language: English')
      let push = pushed(page, '"readingLang":"fr"')
      await page.getByTestId('settings-reading-lang').selectOption('fr')
      await push
      await expect(summary).toHaveAccessibleName('Translate into: Français')
      await expect(summary.locator('[aria-hidden="true"]')).toHaveText('FR')
      await expect(page.locator('html')).toHaveAttribute('lang', 'en')

      await page.getByTestId('nav-reading').click()
      await synced(page)
      await summary.click()
      await expect(menu.getByTestId('language-menu-title')).toHaveText('Translate into')
      await expect(menu.getByTestId('language-menu-fr')).toHaveAttribute('aria-pressed', 'true')
      push = pushed(page, '"readingLang":"zh-Hans"')
      await menu.getByTestId('language-menu-zh-Hans').click()
      await expect(summary).toHaveAccessibleName('Translate into: 简体中文')
      await push
      // The interface stays as it was, here and on the account.
      await expect(page.locator('html')).toHaveAttribute('lang', 'en')
      await expect(page.getByTestId('nav-reading')).toHaveText('Reading')
      expect(await serverLanguages(page.request)).toEqual({
        uiLocale: 'en',
        readingLang: 'zh-Hans',
      })

      // The way back to linking them is Settings → Language, and the menu closes on the way.
      await summary.click()
      const settings = menu.getByTestId('language-menu-settings')
      await expect(settings).toHaveText('Language settings')
      await settings.click()
      await expect(page).toHaveURL(/\/settings\/translation$/)
      await expect(settings).toBeHidden()
      await expect(page.getByTestId('settings-reading-lang')).toHaveValue('zh-Hans')
    } finally {
      await resetReading(page.request)
    }
  })

  test('a paragraph that failed to translate says so, in both layouts', async ({ page }) => {
    await page.goto('/add')
    await page.getByTestId('feed-url').fill(`${FIXTURES}/partial.xml`)
    await page.getByTestId('find-feeds').click()
    await page.getByTestId('feed-candidates').getByTestId('subscribe').first().click()
    await expect(page).toHaveURL(/\/reading\?feed=\d+/)

    const stop = keepCycling(page)
    try {
      const row = page.getByTestId('article-row').first()
      await expect(row).toBeVisible({ timeout: 45_000 })
      await row.click()
      const bar = page.getByTestId('translation-bar')
      await expect(bar).toHaveAttribute('data-state', 'partial', { timeout: 30_000 })
      await expect(bar).toContainText('1 paragraph could not be translated')
    } finally {
      stop()
    }

    const marked = page.locator('.article-untranslated')
    await expect(marked).toHaveCount(1)
    await expect(marked).toContainText('not translated')
    await expect(marked).toContainText('この段落は')
    await expect(marked.getByTestId('body-translated')).toHaveAttribute('lang', 'ja')

    await page.getByTestId('mode-trans').click()
    await expect(page.getByTestId('reader')).toHaveAttribute('data-mode', 'trans')
    await expect(page.getByTestId('body-original')).toHaveCount(0)
    await expect(page.locator('.article-untranslated')).toHaveCount(1)
    await expect(page.locator('.article-untranslated')).toContainText('not translated')
    // The blocks that did translate stay one body between the marks, not one per paragraph.
    await expect(page.locator('.article-body')).toHaveCount(3)

    await page.getByTestId('mode-side').click()
    await page.getByTestId('close-article').click()
  })

  test('the display mode outlives closing an article, and follows the member', async ({ page }) => {
    await page.goto('/reading')
    await synced(page)
    const foreign = page.getByTestId('article-row').filter({ hasText: 'JA → EN' }).first()
    await foreign.click()
    await expect(page.getByTestId('translation-bar')).toHaveAttribute(
      'data-state',
      /done|partial/,
      {
        timeout: 30_000,
      },
    )

    await page.getByTestId('mode-orig').click()
    await page.getByTestId('close-article').click()
    await expect(page).not.toHaveURL(/article=/)
    await foreign.click()
    await expect(page.getByTestId('reader')).toHaveAttribute('data-mode', 'orig')

    // A link with no mode opens the way this member reads: the choice is a synced pref.
    const bare = new URL(page.url())
    bare.searchParams.delete('mode')
    await page.goto(bare.toString())
    await expect(page.getByTestId('reader')).toHaveAttribute('data-mode', 'orig')
    // A row's href never pins a mode a later toggle could not update.
    expect(await page.getByTestId('article-row').first().getAttribute('href')).not.toContain(
      'mode=',
    )

    // Back to the default, or every spec after this one inherits it.
    await page.getByTestId('mode-side').click()
    await expect(page.getByTestId('reader')).toHaveAttribute('data-mode', 'side')

    // Someone else's ?mode=orig link governs the article it names, not this member's preference.
    await page.goto(`${bare.toString()}&mode=orig`)
    await expect(page.getByTestId('reader')).toHaveAttribute('data-mode', 'orig')
    await page.getByTestId('close-article').click()
    await foreign.click()
    await expect(page.getByTestId('reader')).toHaveAttribute('data-mode', 'side')
    await page.getByTestId('close-article').click()
  })
})

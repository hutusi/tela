/**
 * Translation in the reader (ADR 0023): titles eagerly by the sweeps, bodies on open, streamed in
 * chunks and laid over the original. The mock provider prefixes "en:" and drops a block marked
 * [[drop]], which is how a provider omitting an entry looks.
 */
import { type APIRequestContext, expect, type Page, type Route, test } from '@playwright/test'
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

/** The state of the device's stored row for a translation, or null when it holds none. */
function storedTranslation(page: Page, contentKey: string, lang: string): Promise<string | null> {
  return page.evaluate(
    ({ contentKey, lang }) =>
      new Promise<string | null>((resolve) => {
        const open = indexedDB.open('tela-2')
        // Not created yet: never create it empty under the app.
        open.onupgradeneeded = () => open.transaction?.abort()
        open.onerror = () => resolve(null)
        open.onsuccess = () => {
          const db = open.result
          const get = db.transaction('tables').objectStore('tables').get('translations')
          get.onerror = () => {
            db.close()
            resolve(null)
          }
          get.onsuccess = () => {
            db.close()
            const rows = (get.result ?? []) as { contentKey: string; lang: string; state: string }[]
            resolve(rows.find((t) => t.contentKey === contentKey && t.lang === lang)?.state ?? null)
          }
        }
      }),
    { contentKey, lang },
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
    await expect(page.getByTestId('translation-status')).toContainText(
      'Translated to English by Tela.',
    )
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

  /**
   * The device holds titles in the language the member reads in only. A new one is fetched behind
   * the list, by the posts the device holds (`POST /api/v1/sync/titles`), and the list shows each
   * post as written until its title comes: the device never starts over from a snapshot for it.
   * Holding the titles' answer back holds the in-between still.
   */
  test('a new reading language fetches its titles behind the list, never a snapshot', async ({
    page,
  }) => {
    const held: Route[] = []
    let released = false
    await page.route('**/api/v1/sync/titles', (route) => {
      if (released) void route.continue()
      else held.push(route)
    })
    const release = async () => {
      released = true
      for (const route of held.splice(0)) await route.continue().catch(() => undefined)
    }
    try {
      await page.goto('/reading')
      await synced(page)
      const foreign = page.getByTestId('article-row').filter({ hasText: 'JA → EN' }).first()
      await expect(foreign.locator('h2')).toContainText('en:')
      const href = (await foreign.getAttribute('href')) ?? ''
      expect(href).toContain('article=')
      // From here on, any snapshot would be the device starting over.
      const snapshots: string[] = []
      page.on('request', (r) => {
        if (/\/api\/v1\/sync\?cursor=0(&|$)/.test(r.url())) snapshots.push(r.url())
      })

      const menu = page.getByTestId('language-menu')
      await menu.locator('summary').click()
      await menu.getByTestId('language-menu-settings').click()
      await expect(page).toHaveURL(/\/settings\/translation$/)
      const push = pushed(page, '"readingLang":"fr"')
      await page.getByTestId('settings-reading-lang').selectOption('fr')
      await push
      await expect.poll(() => held.length, { timeout: 15_000 }).toBeGreaterThan(0)

      await page.getByTestId('nav-reading').click()
      await synced(page)
      const row = page.locator(`[data-testid="article-row"][href="${href}"]`)
      const heading = row.locator('h2')
      // As written: no English title any more, and no French one yet.
      await expect(heading).toBeVisible()
      await expect(heading).not.toContainText('en:')
      await expect(heading).not.toContainText('fr:')
      await expect(row).not.toContainText('JA → EN')

      await release()
      await expect(heading).toContainText('fr:', { timeout: 30_000 })
      await expect(row).toContainText('JA → FR')
      expect(snapshots).toEqual([])
    } finally {
      await release()
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
      await expect(page.getByTestId('translation-status')).toHaveText(
        'Translated to English by Tela. 1 paragraph could not be translated.',
      )
    } finally {
      stop()
    }

    // The label names the language the paragraph stayed in, and is set in capitals by CSS alone.
    const marked = page.locator('.article-untranslated')
    await expect(marked).toHaveCount(1)
    await expect(marked.locator('.article-untranslated-label')).toHaveText(
      'Not translated · Japanese',
    )
    await expect(marked.locator('.article-untranslated-label')).toHaveCSS(
      'text-transform',
      'uppercase',
    )
    await expect(marked).toContainText('この段落は')
    await expect(marked.getByTestId('body-translated')).toHaveAttribute('lang', 'ja')

    await page.getByTestId('mode-trans').click()
    await expect(page.getByTestId('reader')).toHaveAttribute('data-mode', 'trans')
    await expect(page.getByTestId('body-original')).toHaveCount(0)
    await expect(page.locator('.article-untranslated')).toHaveCount(1)
    await expect(page.locator('.article-untranslated')).toContainText('Not translated · Japanese')
    await expect(page.getByTestId('translating-rest')).toHaveCount(0)
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

  /**
   * The reader fetches a translation's chunks side by side and never asks again for one that
   * failed, so a later chunk can land before an earlier one, or not at all until the finished
   * object replaces them. Translation mode shows the paragraphs up to the first one missing, then
   * a placeholder: never a paragraph after a gap. Holding back every chunk after the first, and
   * the finished object, holds that moment still.
   */
  test('in Translation, what has not landed waits under a placeholder, never after a gap', async ({
    page,
  }) => {
    await setPrefs(page.request, { 'reader.mode': 'trans' })
    const held: Route[] = []
    let released = false
    const hold = (route: Route) => {
      if (released) void route.continue()
      else held.push(route)
    }
    const release = async () => {
      released = true
      for (const route of held.splice(0)) await route.continue().catch(() => undefined)
    }
    // Chunks are `tc/…/<n>.json`; the finished object is `t/…`.
    await page.route(/\/o\/tc\/.+\/[1-9]\d*\.json$/, hold)
    await page.route(/\/o\/t\//, hold)
    const firstChunk = page.waitForResponse((r) => /\/o\/tc\/.+\/0\.json$/.test(r.url()))

    await page.goto('/reading')
    await synced(page)
    await page.getByTestId('subscription').filter({ hasText: 'give IT a try' }).click()
    await expect(page).toHaveURL(/\/reading\?feed=\d+$/)
    const stop = keepCycling(page)
    try {
      // About 1,800 characters of Japanese: past FIRST_CHUNK_TOKENS (400, a token a character),
      // so at least two chunks.
      await page.getByTestId('article-row').filter({ hasText: 'あなたは見分けられる' }).click()
      await expect(page.getByTestId('reader')).toHaveAttribute('data-mode', 'trans', {
        timeout: 30_000,
      })
      const chunk = (await (await firstChunk).json()) as { blocks: Record<string, string> }
      const landed = Object.keys(chunk.blocks).length

      const rest = page.getByTestId('translating-rest')
      await expect(rest).toBeVisible({ timeout: 30_000 })
      await expect(rest).toContainText('Translating the rest…')
      // The first chunk's blocks, in one body, and no source text standing in for the others.
      const blocks = page.locator('[data-testid="body-translated"] > *')
      await expect(page.getByTestId('body-translated')).toHaveCount(1)
      await expect(blocks).toHaveCount(landed)
      await expect(page.getByTestId('body-translated')).toContainText('en:')
      await expect(page.locator('.article-untranslated')).toHaveCount(0)

      await release()
      await expect(rest).toHaveCount(0, { timeout: 30_000 })
      expect(await blocks.count()).toBeGreaterThan(landed)
    } finally {
      stop()
      await release()
    }
  })

  /**
   * A chunk that fails is not asked for again: the finished object brings its blocks. When that
   * cannot be had either (asked for twice), nothing more is on the way, so the placeholder goes,
   * what never came shows as not translated, and the bar offers to try again, which asks for the
   * finished object once more.
   */
  test('a finished translation out of reach shows what never came as not translated, with a retry', async ({
    page,
  }) => {
    await setPrefs(page.request, { 'reader.mode': 'trans' })
    // Every chunk after the first, and the finished object, answered 503.
    const later = /\/o\/tc\/.+\/[1-9]\d*\.json$/
    const finished = /\/o\/t\//
    const refuse = (route: Route) => route.fulfill({ status: 503, body: '' })
    await page.route(later, refuse)
    await page.route(finished, refuse)

    await page.goto('/reading')
    await synced(page)
    await page.getByTestId('subscription').filter({ hasText: 'give IT a try' }).click()
    await expect(page).toHaveURL(/\/reading\?feed=\d+$/)
    const bar = page.getByTestId('translation-bar')
    const rest = page.getByTestId('translating-rest')
    const retry = bar.getByTestId('translation-retry')
    const stop = keepCycling(page)
    try {
      // Two chunks at least (the spec above says why), so the first lands and the rest do not.
      await page.getByTestId('article-row').filter({ hasText: 'あなたは見分けられる' }).click()
      await expect(page.getByTestId('reader')).toHaveAttribute('data-mode', 'trans', {
        timeout: 30_000,
      })
      await expect(bar).toHaveAttribute('data-state', 'failed', { timeout: 30_000 })
      await expect(page.getByTestId('translation-status')).toHaveText('Translation failed.')
      await expect(rest).toHaveCount(0)
      await expect(retry).toHaveText('Try translating again')
      // The first chunk's blocks, translated, then the source standing in for the rest, marked.
      await expect(page.getByTestId('body-translated').first()).toContainText('en:')
      await expect(page.locator('.article-untranslated-label').first()).toHaveText(
        'Not translated · Japanese',
      )

      await page.unroute(later)
      await page.unroute(finished)
      await retry.click()
      await expect(bar).toHaveAttribute('data-state', /done|partial/, { timeout: 30_000 })
      await expect(retry).toHaveCount(0)
      await expect(rest).toHaveCount(0)
      await expect(page.getByTestId('translation-status')).toContainText('Translated to English')
    } finally {
      stop()
    }
  })

  test('a translation that could not be asked for offers to try again, in the bar', async ({
    page,
  }) => {
    // The one request out of reach: the bar says so, and puts the retry where the modes go.
    const asking = '**/api/v1/translations'
    await page.route(asking, (route) =>
      route.request().method() === 'POST' ? route.abort() : route.continue(),
    )
    await page.goto('/reading')
    await synced(page)
    await page.getByTestId('subscription').filter({ hasText: 'give IT a try' }).click()
    await expect(page).toHaveURL(/\/reading\?feed=\d+$/)
    // A post no other spec opens, so opening it asks for its translation.
    await page.getByTestId('article-row').filter({ hasText: '12年ぶりの登壇' }).click()
    const bar = page.getByTestId('translation-bar')
    const retry = bar.getByTestId('translation-retry')
    await expect(page.getByTestId('translation-unavailable')).toBeVisible()
    await expect(retry).toHaveText('Try translating again')
    await expect(bar.getByTestId('mode-side')).toHaveCount(0)
    await expect(page.getByTestId('reader')).toHaveAttribute('data-mode', 'orig')

    await page.unroute(asking)
    const stop = keepCycling(page)
    try {
      await retry.click()
      await expect(page.getByTestId('translation-unavailable')).toHaveCount(0)
      await expect(bar).toHaveAttribute('data-state', /done|partial/, { timeout: 30_000 })
      await expect(retry).toHaveCount(0)
      await expect(bar.getByTestId('mode-side')).toBeVisible()
    } finally {
      stop()
    }
  })

  /**
   * A pull that read a translation's ended row before a new attempt began can land while that
   * attempt's request is out. The device then holds the failure, and the request answers
   * `requested`: the later row, as its seq says, so the reader polls the attempt rather than show
   * a failure nothing follows (Codex's review). Here the pull is made to carry a failed row one
   * seq older than the answer, as a pull that read before the request would; later pulls wait, so
   * nothing but the answer can say the attempt is under way.
   */
  test('a failed row a pull brings while the request is out loses to the request', async ({
    page,
  }) => {
    type Answer = { status: string; translation: { contentKey: string; seq: number } }
    type Row = { contentKey: string; lang: string }
    let answered: (answer: Answer) => void = () => undefined
    const asked = new Promise<Answer>((resolve) => {
      answered = resolve
    })
    let open: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      open = resolve
    })
    let pulls: 'through' | 'stale' | 'held' = 'through'
    await page.route(/\/api\/v1\/sync\?cursor=/, async (route) => {
      if (pulls === 'through') return route.continue()
      if (pulls === 'held') return gate.then(() => route.continue())
      pulls = 'held'
      // Read after the request's write, so no later pull sends its row again.
      const res = await route.fetch()
      const pull = (await res.json()) as { rows: { translations?: Row[] } }
      const { contentKey, seq } = (await asked).translation
      pull.rows.translations = [
        ...(pull.rows.translations ?? []).filter(
          (t) => t.contentKey !== contentKey || t.lang !== 'en',
        ),
        {
          contentKey,
          lang: 'en',
          state: 'failed',
          chunkKeys: [],
          objectKey: null,
          failedLeaves: [],
          seq: seq - 1,
        } as Row,
      ]
      await route.fulfill({ response: res, json: pull })
    })
    await page.route('**/api/v1/translations', async (route) => {
      if (route.request().method() !== 'POST') return route.continue()
      const res = await route.fetch()
      const answer = (await res.json()) as Answer
      answered(answer)
      pulls = 'stale'
      // A pull while the request is out: the app pulls when it comes back online.
      await page.evaluate(() => window.dispatchEvent(new Event('online')))
      const { contentKey } = answer.translation
      for (let i = 0; i < 100; i++) {
        if ((await storedTranslation(page, contentKey, 'en')) === 'failed') break
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      await route.fulfill({ response: res, json: answer })
    })

    await page.goto('/reading')
    await synced(page)
    await page.getByTestId('subscription').filter({ hasText: 'give IT a try' }).click()
    await expect(page).toHaveURL(/\/reading\?feed=\d+$/)
    const bar = page.getByTestId('translation-bar')
    const stop = keepCycling(page)
    try {
      // A post no other spec opens, so opening it asks for its translation.
      await page.getByTestId('article-row').filter({ hasText: 'ギターもベースも' }).click()
      const answer = await asked
      expect(answer.status).toBe('requested')
      await expect(bar).toHaveAttribute('data-state', /done|partial/, { timeout: 30_000 })
      await expect(page.getByTestId('body-translated').first()).toContainText('en:')
      // Still the failure on the device: the answer and the polls behind it showed the attempt.
      expect(await storedTranslation(page, answer.translation.contentKey, 'en')).toBe('failed')
    } finally {
      stop()
      open()
      await page.unrouteAll({ behavior: 'ignoreErrors' })
    }
  })
})

/**
 * Translation in the reader (ADR 0023): titles eagerly by the sweeps, bodies on open, streamed in
 * chunks and laid over the original. The mock provider prefixes "en:" and drops a block marked
 * [[drop]], which is how a provider omitting an entry looks.
 */
import { expect, test } from '@playwright/test'
import { ensureFeeds, FIXTURES, keepCycling, sideBySide, synced } from './helpers'

test.beforeAll(async () => {
  // A Japanese blog, whose titles the setup's sweeps have not seen yet.
  await ensureFeeds(['/jnito.xml'])
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
    await sideBySide(page)
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

  test('a finished translation opens from the device the second time', async ({ page }) => {
    await page.goto('/reading')
    await synced(page)
    const row = page.getByTestId('article-row').filter({ hasText: 'JA → EN' }).first()
    await row.click()
    await sideBySide(page)
    await expect(page.getByTestId('translation-bar')).toHaveAttribute(
      'data-state',
      /done|partial/,
      {
        timeout: 30_000,
      },
    )
    await page.getByTestId('close-article').click()

    const asked: string[] = []
    page.on('request', (r) => {
      const path = new URL(r.url()).pathname
      if (path.startsWith('/api/v1/translations') || path.startsWith('/o/')) asked.push(path)
    })
    await row.click()
    await expect(page.getByTestId('body-translated').first()).toContainText('en:')
    expect(asked).toEqual([])
  })

  test('switching the reading language changes what gets translated', async ({ page }) => {
    await page.goto('/reading')
    await synced(page)
    await page.getByTestId('read-in').getByRole('button', { name: 'ZH' }).click()
    await expect(page.getByTestId('read-in').getByRole('button', { name: 'ZH' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
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
    await page.getByTestId('read-in').getByRole('button', { name: 'EN' }).click()
    await expect(page.getByTestId('article-row').first()).not.toContainText('EN → ZH')
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
      await sideBySide(page)
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

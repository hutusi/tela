/**
 * A translation past a day's limits (ADR 0057): put off to the next UTC midnight, it says when it
 * will come and nothing polls it; declined, it says whose day had no room, calmly. tela-api's
 * answers are given here, so the specs need no day's limits spent: the route tests hold tela-api
 * to them (`apps/api/test/translations.test.ts`).
 */
import { expect, type Page, test } from '@playwright/test'
import { ensureFeeds, resetReading, setPrefs, synced } from './helpers'

const DAY = 86_400_000

/** The next UTC midnight, when a request that waits falls due. */
const midnight = () => (Math.floor(Date.now() / DAY) + 1) * DAY

/** Answer every request for a body translation with `answer`, as tela-api would. */
async function answering(page: Page, answer: (dueAt: number) => Record<string, unknown>) {
  await page.route('**/api/v1/translations', (route) =>
    route.request().method() === 'POST'
      ? route.fulfill({ json: answer(midnight()) })
      : route.continue(),
  )
}

/**
 * Open a Japanese post in French: no other spec reads in French, so no translation of it is on
 * the device, and opening it asks for one.
 */
async function openJapanesePost(page: Page) {
  await page.goto('/reading')
  await synced(page)
  await page.getByTestId('subscription').filter({ hasText: 'give IT a try' }).click()
  await expect(page).toHaveURL(/\/reading\?feed=\d+$/)
  await page.getByTestId('article-row').filter({ hasText: '12年ぶりの登壇' }).click()
  await expect(page.getByTestId('translation-bar')).toBeVisible()
}

test.beforeAll(async () => {
  await ensureFeeds(['/jnito.xml'])
})

test.beforeEach(async ({ page }) => {
  await resetReading(page.request)
  await setPrefs(page.request, {}, { readingLang: 'fr', uiLocale: 'en' })
})

test.afterAll(async ({ request }) => {
  await resetReading(request)
})

test.describe('a translation past the day’s limits', () => {
  test('put off to tomorrow says when it will come, and is not polled', async ({ page }) => {
    await answering(page, (dueAt) => ({
      status: 'scheduled',
      translation: {
        contentKey: 'waiting',
        lang: 'fr',
        state: 'requested',
        chunkKeys: [],
        objectKey: null,
        failedLeaves: [],
        dueAt,
        seq: Number.MAX_SAFE_INTEGER,
      },
      allowance: { perDay: 20, usedToday: 20, resetsAt: dueAt },
    }))
    const polls: string[] = []
    page.on('request', (r) => {
      if (r.method() === 'GET' && /\/api\/v1\/translations\/.+/.test(r.url())) polls.push(r.url())
    })
    await openJapanesePost(page)
    const bar = page.getByTestId('translation-bar')
    await expect(bar).toHaveAttribute('data-state', 'waiting')
    // In the member's own time: the next UTC midnight, 08:00 in Beijing. (How the hour is
    // spaced, and whether it says AM, is the browser's ICU's to choose.)
    await expect(page.getByTestId('translation-status')).toContainText(
      /^Tela will translate this (tomorrow, )?after \d{1,2}:\d{2}.*\.$/,
    )
    // Not an error: no notice under the bar, no retry, and the original stays to read.
    await expect(page.locator('[data-testid^="translation-budget"]')).toHaveCount(0)
    await expect(bar.getByTestId('translation-retry')).toHaveCount(0)
    await expect(page.getByTestId('reader')).toHaveAttribute('data-mode', 'orig')
    // A request under way is polled every 400 ms at first; one that waits is not polled at all.
    await page.waitForTimeout(2500)
    expect(polls).toEqual([])
  })

  test("declined at the member's own count, it says how many a day allows", async ({ page }) => {
    await answering(page, (resetsAt) => ({
      status: 'budget_exhausted',
      translation: null,
      reason: 'member',
      resetsAt,
      allowance: { perDay: 20, usedToday: 20, resetsAt },
    }))
    await openJapanesePost(page)
    await expect(page.getByTestId('translation-budgetMember')).toHaveText(
      "You've had 20 new posts translated today. Open this one again tomorrow.",
    )
  })

  test("declined at the site's day, it says Tela is resting, not that the member spent theirs", async ({
    page,
  }) => {
    await answering(page, (resetsAt) => ({
      status: 'budget_exhausted',
      translation: null,
      reason: 'site',
      resetsAt,
      allowance: { perDay: 20, usedToday: 3, resetsAt },
    }))
    await openJapanesePost(page)
    await expect(page.getByTestId('translation-budgetSite')).toHaveText(
      'Translation is resting for today. Open this post again tomorrow.',
    )
    await expect(page.getByTestId('translation-budgetMember')).toHaveCount(0)
  })
})

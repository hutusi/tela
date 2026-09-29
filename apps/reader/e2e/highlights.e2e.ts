/**
 * Highlights and notes (ADR 0026): made from a selection, painted over the text without touching
 * the article's DOM, kept across reloads, found again when the post changes, and admitted to be
 * gone when the passage is.
 */
import { expect, type Page, test } from '@playwright/test'
import { BASE, cycle, ensureFeeds, FIXTURES, painted, selectText, synced } from './helpers'

const PASSAGE = 'garden teaches patience'

test.describe.configure({ mode: 'serial' })

test.beforeAll(async ({ request }) => {
  await request.post(`${FIXTURES}/__changing?v=1`)
  await ensureFeeds(['/changing.xml'])
})

async function openChanging(page: Page) {
  await page.goto('/reading')
  await synced(page)
  await page.getByTestId('subscription').filter({ hasText: 'Changing Fixture' }).click()
  await page.getByTestId('article-row').filter({ hasText: 'A post that changes' }).click()
  await expect(page.getByTestId('body-original').first()).toBeVisible()
}

test('a selection becomes a highlight with a note, and both survive a reload', async ({ page }) => {
  await openChanging(page)
  await selectText(page, PASSAGE)
  await page.getByTestId('highlight-create').click()
  await expect(page.getByTestId('highlight-item')).toHaveCount(1)
  await expect.poll(() => painted(page)).toEqual([PASSAGE])
  // Painted, not wrapped: the article's own markup is as it was.
  expect(await page.locator('.article-body mark').count()).toBe(0)

  // A click on the painted text opens its note.
  const box = await page.evaluate(() => {
    const range = [
      ...((CSS as unknown as { highlights: Map<string, Set<Range>> }).highlights.get(
        'tela-highlight',
      ) ?? []),
    ][0]
    const rect = range?.getBoundingClientRect()
    return rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null
  })
  expect(box).not.toBeNull()
  await page.mouse.click(box?.x ?? 0, box?.y ?? 0)
  await page.getByTestId('highlight-note-text').fill('The whole point of the post.')
  const saved = page.waitForResponse((r) => r.url().includes('/api/v1/mutations') && r.ok())
  await page.getByTestId('highlight-note-save').click()
  await expect(page.getByTestId('highlights')).toContainText('The whole point of the post.')
  await saved

  await page.reload()
  await expect(page.getByTestId('highlight-item')).toHaveCount(1)
  await expect(page.getByTestId('highlights')).toContainText('The whole point of the post.')
  await expect.poll(() => painted(page)).toEqual([PASSAGE])
})

test('when the post changes, the highlight is found again and written back to the new version', async ({
  page,
  request,
}) => {
  await request.post(`${FIXTURES}/__changing?v=2`)
  await cycle(request, { refetch: true })
  await openChanging(page)
  await expect(page.getByTestId('body-original').first()).toContainText('In short:')
  await expect(page.getByTestId('highlight-item')).toHaveAttribute('data-status', 'shown')
  await expect.poll(() => painted(page)).toEqual([PASSAGE])

  // Every device will find it where this one did: the stored anchor now names the new version.
  await expect
    .poll(async () => {
      const sync = (await (
        await request.get(`${BASE}/api/v1/sync?cursor=0`, { headers: { 'x-tela-client': '1' } })
      ).json()) as {
        rows: {
          articles: { id: number; contentKey: string }[]
          highlights: { articleId: number; contentKey: string }[]
        }
      }
      const h = sync.rows.highlights[0]
      return h
        ? sync.rows.articles.find((a) => a.id === h.articleId)?.contentKey === h.contentKey
        : false
    })
    .toBe(true)
})

test('a passage the post no longer has is kept with its note, and says so', async ({
  page,
  request,
}) => {
  await request.post(`${FIXTURES}/__changing?v=3`)
  await cycle(request, { refetch: true })
  await openChanging(page)
  await expect(page.getByTestId('body-original').first()).toContainText('Something else entirely')
  const item = page.getByTestId('highlight-item')
  await expect(item).toHaveAttribute('data-status', 'detached')
  await expect(item).toContainText(PASSAGE)
  await expect(item).toContainText('The whole point of the post.')
  expect(await painted(page)).toEqual([])
  await item.getByRole('button', { name: 'Remove highlight' }).click()
  await expect(page.getByTestId('highlights')).toHaveCount(0)
})

test('a highlight on the translation belongs to that side and that language', async ({ page }) => {
  await ensureFeeds(['/jnito.xml'])
  await page.goto('/reading')
  await synced(page)
  await page.getByTestId('article-row').filter({ hasText: 'JA → EN' }).first().click()
  await expect(page.getByTestId('translation-bar')).toHaveAttribute('data-state', /done|partial/, {
    timeout: 30_000,
  })
  const text =
    (await page.getByTestId('body-translated').locator('[data-tb]').first().textContent()) ?? ''
  const needle = text.trim().slice(0, 12)
  await selectText(page, needle, 'body-translated')
  await page.getByTestId('highlight-create').click()
  await expect.poll(() => painted(page)).toEqual([needle])

  // The original alone does not show the translation: the highlight waits for it.
  await page.getByTestId('mode-orig').click()
  await expect(page.getByTestId('highlight-item')).toHaveAttribute('data-status', 'elsewhere')
  expect(await painted(page)).toEqual([])
  await page.getByTestId('mode-side').click()
  await expect.poll(() => painted(page)).toEqual([needle])
})

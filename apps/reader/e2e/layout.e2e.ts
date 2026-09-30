/**
 * Which panes show beside the article (ADR 0029): the sidebar hides, on this device, and hiding
 * it is what gives a laptop-sized window its two bilingual columns.
 */
import { expect, type Page, test } from '@playwright/test'
import { ensureFeeds, resetReading, synced } from './helpers'

// The bilingual measurement needs a Japanese blog; adding one the member follows is a no-op.
test.beforeAll(async () => {
  await ensureFeeds(['/jnito.xml'])
})

// Side by side at the default size: the column arithmetic below assumes it. The pane state itself
// needs no reset. It is this device's, in localStorage, and every test's context starts from the
// storage-state file the setup wrote, so a sidebar hidden here is shown again in the next test,
// in `synced()` (which waits for the sidebar's first subscription) and in the mobile project.
test.beforeEach(async ({ page }) => {
  await resetReading(page.request)
})

/** The first pair's cells, as the bilingual matrix in styles.e2e.ts measures them. */
const firstPair = (page: Page) =>
  page.evaluate(() => {
    const rect = (sel: string) => document.querySelector(sel)?.getBoundingClientRect()
    const t = rect('[data-testid="body-translated"]')
    const o = rect('[data-testid="body-original"]')
    const doc = document.documentElement
    return {
      overflow: doc.scrollWidth - doc.clientWidth,
      t: { top: t?.top ?? 0, left: t?.left ?? 0, width: t?.width ?? 0 },
      o: { top: o?.top ?? 0, left: o?.left ?? 0, width: o?.width ?? 0 },
    }
  })

test('the sidebar hides from the head of the list, and stays hidden on this device', async ({
  page,
}) => {
  await page.goto('/reading')
  await synced(page)
  const layout = page.getByTestId('reading-layout')
  const toggle = page.getByTestId('sidebar-toggle')
  await expect(layout).toHaveAttribute('data-sidebar', 'shown')
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')

  await toggle.click()
  await expect(page.locator('aside')).toHaveCount(0)
  await expect(layout).toHaveAttribute('data-sidebar', 'hidden')
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  // The list took the sidebar's column: nothing is left of it.
  expect((await page.getByTestId('article-list').boundingBox())?.x).toBe(0)

  // Remembered on this device, with no round trip to wait for: the next visit reads it back.
  await page.reload()
  await expect(layout).toHaveAttribute('data-sidebar', 'hidden')
  await expect(page.locator('aside')).toHaveCount(0)

  await toggle.click()
  await expect(page.locator('aside')).toBeVisible()
  await expect(layout).toHaveAttribute('data-sidebar', 'shown')
})

test('[ toggles the sidebar, and ? lists it', async ({ page }) => {
  await page.goto('/reading')
  await synced(page)
  await page.keyboard.press('[')
  await expect(page.locator('aside')).toHaveCount(0)
  await page.keyboard.press('[')
  await expect(page.locator('aside')).toBeVisible()
  await page.keyboard.press('?')
  await expect(page.getByTestId('shortcuts')).toContainText('[')
})

test('hiding the sidebar is what gives a 1440px window its two bilingual columns', async ({
  page,
}) => {
  // A 13" or 14" MacBook window. The sidebar and the list take 480px, so the pane is 960px and
  // its content box 896, short of the 1080 the paired body asks for: the pairs interleave.
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/reading')
  await synced(page)
  await page.getByTestId('article-row').filter({ hasText: 'JA → EN' }).first().click()
  await expect(page.getByTestId('translation-bar')).toHaveAttribute('data-state', /done|partial/, {
    timeout: 30_000,
  })
  await expect(page.getByTestId('paired-body')).toBeVisible()
  const stacked = await firstPair(page)
  expect(stacked.t.top, 'stacked while the sidebar is shown').toBeGreaterThan(stacked.o.top)

  // Without the sidebar the pane is 1180px: two columns of (1116 − 40) / 2 = 538px, or ~530 in
  // CI's Linux Chromium with its 15px scrollbar. 500 is the floor styles.e2e.ts holds the pair to.
  await page.getByTestId('sidebar-toggle').click()
  await expect
    .poll(async () => {
      const m = await firstPair(page)
      return Math.abs(m.t.top - m.o.top)
    })
    .toBeLessThan(4)
  const paired = await firstPair(page)
  expect(paired.o.left, 'the original is not the left-hand column').toBeLessThan(paired.t.left)
  expect(paired.t.width, 'translation column is cramped').toBeGreaterThanOrEqual(520)
  expect(paired.o.width, 'original column is cramped').toBeGreaterThanOrEqual(520)
  expect(paired.overflow, 'horizontal overflow').toBeLessThanOrEqual(0)
})

/** Where an element sits in the reader pane: its two margins, and its width. */
const margins = (page: Page, selector: string) =>
  page.evaluate((selector) => {
    const pane = document.querySelector('[data-testid="reader"]')?.getBoundingClientRect()
    const el = document.querySelector(selector)?.getBoundingClientRect()
    if (!pane || !el) return null
    return { left: el.left - pane.left, right: pane.right - el.right, width: el.width }
  }, selector)

test('the column is centred in the pane, at the width the member chose', async ({ page }) => {
  // 1280 is Playwright's desktop default and a common laptop: the pane is 800px and its content
  // box 736, so a 640px column has 48px to spare on each side. Before, all 96 sat on the right.
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto('/reading')
  await synced(page)
  await page.getByTestId('article-row').filter({ hasText: 'JA → EN' }).first().click()
  await expect(page.getByTestId('translation-bar')).toHaveAttribute('data-state', /done|partial/, {
    timeout: 30_000,
  })
  await expect(page.getByTestId('paired-body')).toBeVisible()
  const centred = (m: { left: number; right: number } | null) =>
    m !== null && Math.abs(m.left - m.right) < 2

  // Side by side, stacked at this width: the pair's column.
  let m = await margins(page, '[data-testid="body-original"]')
  expect(m?.width, 'stacked pair at the measure').toBe(640)
  expect(centred(m), `stacked pair not centred: ${JSON.stringify(m)}`).toBe(true)

  // Translation alone: the same column.
  await page.getByTestId('mode-trans').click()
  m = await margins(page, '[data-testid="article-title"]')
  expect(m?.width).toBe(640)
  expect(centred(m), `single column not centred: ${JSON.stringify(m)}`).toBe(true)

  // A wider measure reaches the stacked pair too, which used to stop at 640 whatever was chosen.
  await page.getByTestId('typography-button').click()
  await page.getByTestId('measure-wide').click()
  await page.getByTestId('mode-side').click()
  await expect(page.getByTestId('paired-body')).toBeVisible()
  m = await margins(page, '[data-testid="body-original"]')
  expect(m?.width, 'a stacked pair ignores the wide measure').toBeGreaterThan(700)
  expect(centred(m)).toBe(true)

  // A post with nothing to translate: its original, centred like the rest.
  await page.getByTestId('typography-button').click()
  await page.getByTestId('measure-normal').click()
  await page.getByTestId('subscription').filter({ hasText: 'Julia Evans' }).first().click()
  await page.getByTestId('article-row').first().click()
  await expect(page.getByTestId('article-title')).toBeVisible()
  m = await margins(page, '[data-testid="article-title"]')
  expect(m?.width).toBe(640)
  expect(centred(m), `original not centred: ${JSON.stringify(m)}`).toBe(true)
})

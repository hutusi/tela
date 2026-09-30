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

test('the sidebar hides from its own header, and stays hidden on this device', async ({ page }) => {
  await page.goto('/reading')
  await synced(page)
  const layout = page.getByTestId('reading-layout')
  const aside = page.locator('aside')
  const list = page.getByTestId('article-list')
  const toggle = page.getByTestId('sidebar-toggle')
  await expect(layout).toHaveAttribute('data-sidebar', 'shown')
  // Shown, the toggle heads the sidebar it hides, and the list has none of its own.
  await expect(aside.getByTestId('sidebar-toggle')).toHaveAttribute('aria-expanded', 'true')
  await expect(list.getByTestId('sidebar-toggle')).toHaveCount(0)

  await toggle.click()
  await expect(aside).toHaveCount(0)
  await expect(layout).toHaveAttribute('data-sidebar', 'hidden')
  // Hidden, it heads the list, which took the sidebar's column: nothing is left of it.
  await expect(list.getByTestId('sidebar-toggle')).toHaveAttribute('aria-expanded', 'false')
  expect((await list.boundingBox())?.x).toBe(0)

  // Remembered on this device, with no round trip to wait for: the next visit reads it back.
  await page.reload()
  await expect(layout).toHaveAttribute('data-sidebar', 'hidden')
  await expect(aside).toHaveCount(0)

  await toggle.click()
  await expect(aside).toBeVisible()
  await expect(layout).toHaveAttribute('data-sidebar', 'shown')
})

/** Where the sidebar's header sits against what is under it, in viewport pixels. */
const header = (page: Page) =>
  page.evaluate(() => {
    const aside = document.querySelector('aside')
    if (!aside) return null
    // Where a heading's words start, not its box, which the padding puts at the aside's edge.
    const textLeft = (text: string) => {
      const walk = document.createTreeWalker(aside, NodeFilter.SHOW_TEXT)
      for (let n = walk.nextNode(); n; n = walk.nextNode()) {
        if (n.textContent !== text) continue
        const range = document.createRange()
        range.selectNodeContents(n)
        return range.getBoundingClientRect().left
      }
      return Number.NaN
    }
    const rect = (sel: string) => aside.querySelector(sel)?.getBoundingClientRect()
    return {
      library: textLeft('Library'),
      subscriptions: textLeft('Subscriptions'),
      icon: rect('[data-testid="sidebar-toggle"] svg')?.right ?? Number.NaN,
      count: rect('nav a span:last-child')?.right ?? Number.NaN,
      toggle:
        (rect('[data-testid="sidebar-toggle"]')?.top ?? Number.NaN) -
        aside.getBoundingClientRect().top,
      overflows: aside.scrollHeight > aside.clientHeight,
    }
  })

test('the sidebar header lines up with the rows under it, and stays as they scroll', async ({
  page,
}) => {
  // Short enough that the subscriptions overflow and the aside scrolls on its own.
  await page.setViewportSize({ width: 1280, height: 420 })
  await page.goto('/reading')
  await synced(page)
  const before = await header(page)
  expect(before, 'no sidebar').not.toBeNull()
  if (!before) return
  // "Library" at the headings' indent, and the icon's right edge on the counts'.
  expect(Math.abs(before.library - before.subscriptions), JSON.stringify(before)).toBeLessThan(1)
  expect(Math.abs(before.icon - before.count), JSON.stringify(before)).toBeLessThan(1)

  // Scrolled to its end, the toggle is where it was: the header is sticky, and its top padding is
  // its own, so it reads the same stuck as at rest.
  expect(before.overflows, 'the aside does not scroll at this height').toBe(true)
  await page.locator('aside').evaluate((el) => {
    el.scrollTop = el.scrollHeight
  })
  const after = await header(page)
  expect(
    Math.abs((after?.toggle ?? Number.NaN) - before.toggle),
    JSON.stringify(after),
  ).toBeLessThan(1)
  await expect(page.getByTestId('sidebar-toggle')).toBeInViewport()
})

test('a toggle that had focus keeps it in its other place', async ({ page }) => {
  // Each state has its own toggle, so the one pressed is gone once it has done its work.
  await page.goto('/reading')
  await synced(page)
  const list = page.getByTestId('article-list')
  await page.getByTestId('sidebar-toggle').focus()
  await page.keyboard.press('Enter')
  await expect(page.locator('aside')).toHaveCount(0)
  await expect(list.getByTestId('sidebar-toggle')).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.locator('aside').getByTestId('sidebar-toggle')).toBeFocused()
  // [ from the toggle hands it on too.
  await page.keyboard.press('[')
  await expect(list.getByTestId('sidebar-toggle')).toBeFocused()
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

test('focus hides the list too while an article is open, and j, k and Esc carry on', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto('/reading')
  await synced(page)
  await page.getByTestId('subscription').filter({ hasText: 'Julia Evans' }).click()
  await expect(page).toHaveURL(/feed=\d+$/)
  const rows = page.getByTestId('article-row')
  await expect(rows.first()).toContainText('Julia Evans')
  const first = await rows.nth(0).getAttribute('data-article-id')
  const second = await rows.nth(1).getAttribute('data-article-id')
  await page.keyboard.press('j')
  await expect(page).toHaveURL(new RegExp(`article=${first}$`))

  const layout = page.getByTestId('reading-layout')
  const toggle = page.getByTestId('focus-toggle')
  const list = page.getByTestId('article-list')
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  // What the list holds must survive focus — its page of rows ("Older articles") and its scroll —
  // or an Esc past row 200 finds no row to focus. A property set on the element proves it was
  // never remounted; scrolling its row out of view first proves it comes back with the row shown.
  await list.evaluate((el) => {
    ;(el as HTMLElement & { kept?: boolean }).kept = true
    el.scrollTop = 400
  })
  await toggle.click()
  await expect(layout).toHaveAttribute('data-focus', '1')
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  await expect(list).toBeHidden()
  await expect(page.locator('aside')).toHaveCount(0)
  // The article has the pane to itself.
  expect((await page.getByTestId('reader').boundingBox())?.width).toBeGreaterThanOrEqual(1200)
  await page.keyboard.press('f')
  await expect(list).toBeVisible()
  expect(await list.evaluate((el) => (el as HTMLElement & { kept?: boolean }).kept)).toBe(true)
  const rowInView = () =>
    page.evaluate((id) => {
      const list = document.querySelector('[data-testid="article-list"]')?.getBoundingClientRect()
      const row = document
        .querySelector(`[data-testid="article-row"][data-article-id="${id}"]`)
        ?.getBoundingClientRect()
      return !!list && !!row && row.top >= list.top && row.bottom <= list.bottom
    }, first)
  await expect.poll(rowInView, { message: 'the open row is not in view' }).toBe(true)
  await toggle.click()
  await expect(list).toBeHidden()

  // The keys still walk the list, which is in the store, not on screen; and Esc puts the list
  // back with focus on the row it closed, as it does with the list in view.
  await page.keyboard.press('j')
  await expect(page).toHaveURL(new RegExp(`article=${second}$`))
  await page.keyboard.press('Escape')
  await expect(page).not.toHaveURL(/article=/)
  await expect(list).toBeVisible()
  await expect(layout).not.toHaveAttribute('data-focus')
  await expect
    .poll(() => page.evaluate(() => document.activeElement?.getAttribute('data-article-id')))
    .toBe(second)

  // Remembered: the next article opens in focus, and f brings the list back.
  await page.keyboard.press('j')
  await expect(page).toHaveURL(/article=\d+$/)
  await expect(list).toBeHidden()
  await page.keyboard.press('f')
  await expect(list).toBeVisible()
  await expect(layout).not.toHaveAttribute('data-focus')
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
})

test('focus is what gives a 1280px window its two bilingual columns', async ({ page }) => {
  // With the sidebar hidden the pane is still 1020px here; only the list going too gets it past
  // 1080: (1216 − 40) / 2 = 588px columns, ~580 in CI's Linux Chromium.
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto('/reading')
  await synced(page)
  await page.getByTestId('article-row').filter({ hasText: 'JA → EN' }).first().click()
  await expect(page.getByTestId('translation-bar')).toHaveAttribute('data-state', /done|partial/, {
    timeout: 30_000,
  })
  await expect(page.getByTestId('paired-body')).toBeVisible()
  const stacked = await firstPair(page)
  expect(stacked.t.top, 'stacked with the list beside it').toBeGreaterThan(stacked.o.top)

  await page.getByTestId('focus-toggle').click()
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

test('a change made in another tab reaches a tab that was away from the reading page', async ({
  page,
  context,
}) => {
  // Leaving /reading takes its subscribers with it. The store once heard other tabs only through
  // them, so a tab that came back was handed the layout it had left with.
  await page.goto('/reading')
  await synced(page)
  await page.locator('header nav').getByRole('link', { name: 'Settings' }).click()
  await expect(page).toHaveURL(/\/settings$/)

  const other = await context.newPage()
  await other.goto('/reading')
  await synced(other)
  await other.getByTestId('sidebar-toggle').click()
  await expect(other.locator('aside')).toHaveCount(0)

  // Back by the header pill: a navigation inside the app, so nothing is reloaded or re-read.
  await page.locator('header nav').getByRole('link', { name: 'Reading' }).click()
  await expect(page).toHaveURL(/\/reading$/)
  await expect(page.getByTestId('reading-layout')).toHaveAttribute('data-sidebar', 'hidden')
  await expect(page.locator('aside')).toHaveCount(0)
  await other.close()
})

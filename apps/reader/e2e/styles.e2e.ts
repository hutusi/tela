import { expect, type Locator, type Page, test } from '@playwright/test'
import { ensureFeeds, expectHeaderFits, measureHeader, resetReading, synced } from './helpers'

/**
 * What the class strings claim, checked against what the browser computes.
 *
 * These would all have passed as source review. The `a` rules in globals.css sat outside any
 * cascade layer, and an unlayered declaration outranks every layered one — including `@layer
 * utilities`, where Tailwind puts everything. So `text-ink` and `hover:no-underline` on the header
 * links resolved to nothing, and the whole chrome rendered accent green and underlined on hover
 * while the JSX said otherwise. Only a rendering browser can tell the difference.
 */

const INK = 'rgb(31, 28, 24)'

const decoration = (l: Locator) => l.evaluate((el) => getComputedStyle(el).textDecorationLine)

/**
 * The lockup and the header's pills are ink in every state: the design carries the active pill on
 * its background alone, so a colour difference here would be a second signal for the same thing.
 * `toHaveCSS` finds the link again on each try, so a header rendered anew in between is measured
 * as it is now, never as a detached element (whose computed style is empty).
 */
async function expectInkLinks(page: Page, pills: string[]): Promise<void> {
  const links: [string, Locator][] = [
    ['lockup', page.getByRole('banner').getByRole('link', { name: 'Tela' })],
    ...pills.map((key): [string, Locator] => [key, page.getByTestId(`nav-${key}`)]),
  ]
  for (const [name, link] of links) {
    await expect(link, name).toHaveCSS('color', INK)
    await expect(link, name).toHaveCSS('text-decoration-line', 'none')
    await link.hover()
    await expect(link, name).toHaveCSS('text-decoration-line', 'none')
  }
}

// The bilingual measurements need a Japanese blog; adding one the member follows is a no-op.
test.beforeAll(async () => {
  await ensureFeeds(['/jnito.xml'])
})

// Every spec here reads in English, side by side, at the default size and theme.
test.beforeEach(async ({ page }) => {
  await resetReading(page.request)
})

test.describe('stylesheet', () => {
  test('the header renders in ink and never underlines', async ({ page }) => {
    await page.goto('/reading')
    // A device holding no rows yet shows the visitor's header until /me answers (ADR 0035), and
    // the member's replaces it whole: wait for the member's, and let every check find its link
    // again, as an element read once may be the one just taken out of the page.
    await expect(page.getByTestId('nav-reading')).toBeVisible()
    await expectInkLinks(page, ['reading', 'discover', 'following'])
  })

  test("the visitor's header renders in ink and never underlines too", async ({ browser }) => {
    const visitor = await browser.newContext({ storageState: { cookies: [], origins: [] } })
    try {
      const page = await visitor.newPage()
      await page.goto('/')
      await expect(page.getByTestId('nav-join')).toBeVisible()
      await expectInkLinks(page, ['discover', 'writers', 'login'])
      // Join is the one filled pill, so not ink; it never underlines either.
      const join = page.getByTestId('nav-join')
      await expect(join).toHaveCSS('text-decoration-line', 'none')
      await join.hover()
      await expect(join).toHaveCSS('text-decoration-line', 'none')
    } finally {
      await visitor.close()
    }
  })

  test('the mark sits in the header lockup', async ({ page }) => {
    await page.goto('/reading')
    const mark = page.getByRole('banner').getByRole('link', { name: 'Tela' }).locator('svg')
    await expect(mark).toBeVisible()
    // aria-hidden, because the wordmark beside it already says the name.
    await expect(mark).toHaveAttribute('aria-hidden', 'true')
  })

  test('a link inside a post keeps its underline', async ({ page }) => {
    await page.goto('/reading')
    await synced(page)
    // .first(): earlier specs add feeds, so by the time this runs the name is not unique.
    await page.getByTestId('subscription').filter({ hasText: 'Julia Evans' }).first().click()
    // Wait for this feed's own list before reaching into it. Clicking straight through picked
    // whichever row "All articles" still had, which is a different post that need not have a body.
    await expect(page).toHaveURL(/\/reading\?feed=\d+/)
    await expect(page.getByTestId('article-row').first()).toBeVisible()

    // Not every post contains a link, so walk until one does rather than trusting row zero. The
    // title match is what proves the pane has actually swapped to the row clicked.
    const rows = page.getByTestId('article-row')
    const tries = Math.min(await rows.count(), 5)
    let link: Locator | null = null
    for (let i = 0; i < tries && link === null; i++) {
      const row = rows.nth(i)
      const title = (await row.locator('h2').textContent())?.trim() ?? ''
      await row.click()
      await expect(page.getByTestId('article-title')).toHaveText(title)
      const body = page.locator('.article-body').first()
      await expect(body).toBeVisible()
      if ((await body.locator('a').count()) > 0) link = body.locator('a').first()
    }

    // The .article-body rules stay unlayered on purpose. Prose links need an affordance the
    // chrome does not, and layering them alongside the rest would take it away everywhere.
    expect(link, 'no post in this feed has a link in its body').not.toBeNull()
    expect(await decoration(link as Locator)).toBe('underline')
  })

  /**
   * The header's breakpoint used to be `md`, where the wordmark and a fixed 240px search field
   * arrived together and cost more width than 768px had. The nav lost the contest: measured on
   * main it was 4px wide at 768 and 36px at 800, so Dashboard and Settings were unreachable with a
   * pointer from 768px to about 1100px. The matrix ran 412 and 1280 and saw none of it.
   */
  for (const width of [640, 768, 800, 1024, 1280]) {
    test(`the header fits and keeps its nav at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 })
      await page.goto('/reading')
      // The Read-in menu appears once the session is known and is 140px wide ("Read in 中文 EN").
      // Measuring before it lands reads a header ~150px lighter than the one a member sees, which
      // passes when it shouldn't.
      await page.getByTestId('read-in').waitFor({ state: 'attached' })

      const m = await measureHeader(page, ['account-menu'])
      expectHeaderFits(m, width)
      // The one way to Settings, the Dashboard and signing out: whole, and on screen.
      expect(m.controls['account-menu']?.width, 'account menu squeezed').toBe(30)
    })
  }

  /**
   * The bilingual body was two whole documents in two grid cells, switched by `xl:grid-cols-2` —
   * a 1280px *viewport*. But the reader pane is the third cell of a `220px 260px 1fr` grid, so at
   * 1280 it is 800px wide: less padding and the gap, that is 348px per column, about 32 characters
   * of 19.5px Garamond. The suite ran 412 and 1280 and asserted only that both bodies were
   * *visible*, which is equally true when they are stacked. Nothing measured the columns.
   */
  for (const width of [1280, 1440, 1700]) {
    test(`the bilingual reader never renders a cramped column at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 })
      await page.goto('/reading')
      await synced(page)
      const row = page.getByTestId('article-row').filter({ hasText: 'JA → EN' }).first()
      await row.click()
      await expect(page.getByTestId('translation-bar')).toHaveAttribute(
        'data-state',
        /done|partial/,
        { timeout: 30_000 },
      )
      await expect(page.getByTestId('paired-body')).toBeVisible()

      const m = await page.evaluate(() => {
        const at = (sel: string) =>
          [...document.querySelectorAll(sel)].map((el) => el.getBoundingClientRect())
        const t = at('[data-testid="body-translated"]')
        const o = at('[data-testid="body-original"]')
        const doc = document.documentElement
        return {
          count: t.length,
          paired: o.length,
          overflow: doc.scrollWidth - doc.clientWidth,
          t0: { top: t[0]?.top ?? 0, width: t[0]?.width ?? 0, left: t[0]?.left ?? 0 },
          o0: { top: o[0]?.top ?? 0, width: o[0]?.width ?? 0, left: o[0]?.left ?? 0 },
          t1: t[1]?.top ?? 0,
          o1: o[1]?.top ?? 0,
        }
      })

      // More than one of each is the proof that this is really paired block by block rather than
      // two whole bodies in two cells, which is what every earlier assertion would also accept.
      expect(m.count, 'blocks are not paired').toBeGreaterThan(1)
      expect(m.paired).toBe(m.count)
      expect(m.overflow, 'horizontal overflow').toBeLessThanOrEqual(0)

      const twoColumns = Math.abs(m.t0.top - m.o0.top) < 4
      if (twoColumns) {
        // The original leads, as every facing-page edition does, and as the stacked order does.
        expect(m.o0.left, 'the original is not the left-hand column').toBeLessThan(m.t0.left)
        // Two columns only when each can hold a line. 348px is the number this test exists for.
        expect(m.t0.width, 'translation column is cramped').toBeGreaterThanOrEqual(500)
        expect(m.o0.width, 'original column is cramped').toBeGreaterThanOrEqual(500)
        // Rows align by construction; if this drifts the pairing has stopped being a grid.
        expect(Math.abs(m.t1 - m.o1), 'pair 2 does not line up').toBeLessThan(1)
      } else {
        // Stacked is the interleave, not two whole bodies: each source paragraph is followed by
        // its own translation and then the next pair, and both keep the full measure.
        expect(m.t0.width, 'interleaved column is cramped').toBeGreaterThanOrEqual(500)
        expect(m.t0.top, 'translation does not follow its original').toBeGreaterThan(m.o0.top)
        expect(m.o1, 'next pair does not follow the translation').toBeGreaterThan(m.t0.top)
      }
    })
  }

  test('the fade is off when the reader asks for less motion', async ({ page }) => {
    // Opening an article is the most repeated interaction in the app, and it fades every time.
    // The override is on the token rather than the utility, which assumes Tailwind compiles
    // `animate-fade` to `animation: var(--animate-fade)` — an assumption only a browser settles.
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.goto('/reading')
    await page.getByTestId('article-row').first().click()
    const reader = page.getByTestId('reader')
    await expect(reader).toBeVisible()
    expect(await reader.evaluate((el) => getComputedStyle(el).animationName)).toBe('none')

    await page.emulateMedia({ reducedMotion: 'no-preference' })
    await page.reload()
    expect(await reader.evaluate((el) => getComputedStyle(el).animationName)).toBe('fade')
  })

  test('pairing the blocks keeps the single-column vertical rhythm', async ({ page }) => {
    // Every block is its own .article-body and a grid item, and grid items do not collapse
    // margins with siblings: a 20px paragraph margin against a 32px heading margin would sum to
    // 52 where one column resolves them to 32. Nothing in the JSX shows that.
    //
    // The margins are the invariant, not the gap on screen. Rows align to the taller side, so a
    // longer original legitimately pushes the next row down — that slack is what alignment is.
    await page.setViewportSize({ width: 1700, height: 1000 })
    await page.goto('/reading')
    await synced(page)
    await page.getByTestId('article-row').filter({ hasText: 'JA → EN' }).first().click()
    await expect(page.getByTestId('translation-bar')).toHaveAttribute(
      'data-state',
      /done|partial/,
      {
        timeout: 30_000,
      },
    )

    const measure = () => {
      const cells = [...document.querySelectorAll('[data-testid="body-translated"]')]
      // From index 1: a gap needs something before the heading, and this article opens with one.
      const i = cells.findIndex(
        (el, idx) => idx > 0 && (el.firstElementChild?.matches('h1,h2,h3,h4,h5,h6') ?? false),
      )
      if (i < 1) return null
      const cell = cells[i] as HTMLElement
      const head = cell.firstElementChild as HTMLElement
      const prevCell = cells[i - 1] as HTMLElement
      const prev = prevCell.lastElementChild as HTMLElement
      const px = (el: Element, prop: 'marginTop' | 'marginBottom') =>
        Number.parseFloat(getComputedStyle(el)[prop])
      return {
        id: head.getAttribute('data-tb'),
        prevId: prev.getAttribute('data-tb'),
        // What one column would have collapsed to, assembled from the three parts instead.
        margins: px(prev, 'marginBottom') + px(cell, 'marginTop') + px(head, 'marginTop'),
        gap: head.getBoundingClientRect().top - prev.getBoundingClientRect().bottom,
      }
    }
    // The bar can say done before the paired body has rendered its cells: a slow runner measured
    // in between and found nothing. Wait for the pair, then measure it.
    await expect
      .poll(() => page.evaluate(measure), { message: 'no heading to measure against' })
      .not.toBeNull()
    const paired = await page.evaluate(measure)

    await page.getByTestId('mode-trans').click()
    await expect(page.locator('.article-body')).toHaveCount(1)
    const single = await page.evaluate(
      ({ id, prevId }) => {
        const head = document.querySelector(`[data-tb="${id}"]`)
        const prev = document.querySelector(`[data-tb="${prevId}"]`)
        if (!head || !prev) return null
        return head.getBoundingClientRect().top - prev.getBoundingClientRect().bottom
      },
      { id: paired?.id, prevId: paired?.prevId },
    )
    expect(single, 'the same two blocks are not in the single column').not.toBeNull()

    // 32, not 52: the top margin is zeroed on the block and put back on the row.
    expect(paired?.margins, 'paired margins do not add up to the collapsed gap').toBe(
      single as number,
    )
    expect(paired?.gap, 'paired blocks sit tighter than one column').toBeGreaterThanOrEqual(
      single as number,
    )
  })

  test('search is reachable below the desktop breakpoint too', async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 900 })
    await page.goto('/reading')
    // The field costs 240px the nav needs, so below lg it collapses to a link to the same page.
    await expect(page.getByTestId('search-input')).toBeHidden()
    await page.getByTestId('search-link').click()
    await expect(page).toHaveURL(/\/search$/)

    // Arriving is not the point — the link was a dead end while the only input on the site was the
    // header's, which is hidden at this width. The page has to carry one that submits.
    const field = page.getByTestId('search-page-input')
    await expect(field).toBeVisible()
    await field.fill('Julia')
    await field.press('Enter')
    await expect(page).toHaveURL(/\/search\?q=Julia/)
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Julia')

    await page.setViewportSize({ width: 1280, height: 900 })
    await page.goto('/reading')
    await expect(page.getByTestId('search-input')).toBeVisible()
    await expect(page.getByTestId('search-link')).toBeHidden()
  })

  /**
   * Dark mode is the same tokens on another ground, so it is only as good as the computed colours
   * say: a utility with a literal colour (`bg-white` was on 31 elements) would stay light.
   */
  test("the theme follows the system, and a member's choice overrides it", async ({ page }) => {
    const paper = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor)
    const ink = () => page.evaluate(() => getComputedStyle(document.body).color)
    await page.emulateMedia({ colorScheme: 'dark' })
    await page.goto('/settings/reading')
    await page.getByTestId('theme-system').click()
    expect(await paper()).toBe('rgb(22, 20, 15)')
    expect(await ink()).toBe('rgb(237, 231, 219)')

    await page.getByTestId('theme-light').click()
    expect(await paper()).toBe('rgb(246, 242, 234)')

    await page.emulateMedia({ colorScheme: 'light' })
    const pushed = page.waitForResponse((r) => r.url().includes('/api/v1/mutations') && r.ok())
    await page.getByTestId('theme-dark').click()
    expect(await paper()).toBe('rgb(22, 20, 15)')
    await pushed
    // The next visit is dark from the first paint: the inline script, before any app code.
    await page.reload({ waitUntil: 'commit' })
    await page.waitForFunction(() => document.body !== null)
    expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe('dark')

    await page.getByTestId('theme-system').click()
    expect(await paper()).toBe('rgb(246, 242, 234)')
  })

  test("text size and line length are the member's, and reach the article", async ({ page }) => {
    await page.goto('/reading')
    await synced(page)
    await page.getByTestId('subscription').filter({ hasText: 'Julia Evans' }).first().click()
    await page.getByTestId('article-row').first().click()
    const body = page.locator('[data-testid="body-original"]').first()
    await expect(body).toBeVisible()
    const size = () => body.evaluate((el) => getComputedStyle(el).fontSize)
    const measure = () =>
      body.evaluate((el) => (el.parentElement ? getComputedStyle(el.parentElement).maxWidth : ''))
    expect(await size()).toBe('19.5px')
    expect(await measure()).toBe('640px')

    await page.getByTestId('typography-button').click()
    await page.getByTestId('size-xl').click()
    await page.getByTestId('measure-wide').click()
    expect(Number.parseFloat(await size())).toBeCloseTo(19.5 * 1.27, 1)
    expect(await measure()).toBe('760px')

    // Synced prefs: a reload (and every other device) reads the same way.
    await page.waitForResponse((r) => r.url().includes('/api/v1/mutations') && r.ok())
    await page.reload()
    await expect(body).toBeVisible()
    expect(await measure()).toBe('760px')
    await page.getByTestId('typography-button').click()
    await page.getByTestId('size-m').click()
    await page.getByTestId('measure-normal').click()
    expect(await size()).toBe('19.5px')
  })
})

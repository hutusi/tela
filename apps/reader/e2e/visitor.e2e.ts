/**
 * The front page (ADR 0035): rendered at the edge for a visitor, whole without JavaScript, and
 * kept current by the app; a member gets the app itself and goes to their reading. Four blogs
 * that wrote this week (`./fresh.ts`) are curated first, so the edition has posts in four
 * languages whatever day the run is on.
 */
import { expect, request, test } from '@playwright/test'
import { FRESH, FRESH_LANGS } from './fresh'
import { ADMIN_TOKEN, BASE, cycle, FIXTURES } from './helpers'

const VISITOR = { storageState: { cookies: [], origins: [] } }

test.beforeAll(async () => {
  const admin = await request.newContext({ baseURL: BASE })
  try {
    const curate = async () => {
      for (const lang of FRESH_LANGS) {
        const res = await admin.post(`${BASE}/api/admin/curate`, {
          headers: { origin: BASE, authorization: `Bearer ${ADMIN_TOKEN}` },
          data: { feedUrl: `${FIXTURES}/fresh/${lang}.xml`, topics: [], featured: true },
        })
        expect(res.ok()).toBe(true)
      }
    }
    await curate()
    await cycle(admin)
    // A feed added by its address starts on its host's blog, and its first fetch moves it to the
    // home it declares: featured again there, which changes nothing if it was already.
    await curate()
    await cycle(admin)
  } finally {
    await admin.dispose()
  }
})

test.describe('without JavaScript', () => {
  test.use({ ...VISITOR, javaScriptEnabled: false })

  test('the front page is a whole page, never indexed', async ({ page }) => {
    const res = await page.goto('/')
    expect(res?.status()).toBe(200)
    expect(res?.headers()['x-robots-tag']).toBe('noindex, nofollow')
    expect(res?.headers().vary).toContain('cookie')
    await expect(page.locator('meta[name="robots"]')).toHaveCount(0)
    await expect(page).toHaveTitle('Tela')
    // Structure only: the colo may hold a copy rendered by an earlier spec, before the curation.
    await expect(page.getByRole('heading', { level: 1 })).toContainText('A confluence of')
    await expect(page.getByTestId('front-strip')).toBeVisible()
    await expect(page.getByTestId('titles-translated')).toHaveAttribute(
      'href',
      '/?titles=translated',
    )
    await expect(page.getByTestId('front-join')).toHaveAttribute('href', '/join')
    await expect(page.getByTestId('front-login')).toHaveAttribute('href', '/login')
    await expect(page.getByTestId('writers-strip').getByRole('link')).toHaveAttribute(
      'href',
      '/writers',
    )
    await expect(page.getByTestId('site-footer')).toBeVisible()
    await expect(page.locator('#tela-data')).toHaveCount(1)
  })

  test('the theme menu shows the choice from the stylesheet alone, and opens before any script', async ({
    page,
  }) => {
    // One cached page for every visitor: with no choice on the page, its glyph and name are Auto,
    // whatever the system shows, and no item claims to be chosen.
    await page.emulateMedia({ colorScheme: 'dark' })
    await page.goto('/')
    const menu = page.getByTestId('theme-menu')
    const summary = menu.locator('summary')
    await expect(summary).toHaveAccessibleName('Theme: Auto')
    await expect(summary.locator('.theme-is-system svg')).toBeVisible()
    await expect(summary.locator('.theme-is-dark svg')).toBeHidden()
    await expect(summary.locator('.theme-is-light svg')).toBeHidden()
    await summary.click()
    await expect(menu.getByRole('button')).toHaveText(['Auto', 'Light', 'Dark'])
    await expect(menu.locator('[aria-pressed]')).toHaveCount(0)
  })
})

test.describe('with JavaScript', () => {
  test.use(VISITOR)

  test("this week's posts, and their titles as written or in the reader's language", async ({
    page,
  }) => {
    await page.goto('/')
    // The hero's doors are the header's: once the app runs, Join opens the sheet over the page.
    await page.getByTestId('front-join').click()
    const sheet = page.getByTestId('front-door')
    await expect(sheet.getByTestId('join-code')).toBeFocused()
    await expect(page).toHaveURL(/\/$/)
    await page.keyboard.press('Escape')
    await expect(sheet).toHaveCount(0)
    await expect(page.getByTestId('front-strip')).toContainText(
      /This week, \d+ blogs? wrote in \d+ languages?/,
    )
    // The app asks tela-api past the edge's copy, so the curated posts are there.
    for (const lang of FRESH_LANGS) {
      await expect(
        page.getByTestId('front-title').filter({ hasText: FRESH[lang].titles[0] }),
      ).toBeVisible()
    }
    const spanish = page.locator('article', { hasText: FRESH.es.titles[0] })
    await expect(spanish.getByTestId('front-title')).toHaveText(FRESH.es.titles[0])
    await expect(spanish.getByTestId('front-title')).toHaveAttribute('lang', 'es')
    // No language label beside a post (ADR 0070): each title says its language to the browser.
    await expect(spanish.getByTestId('front-lang')).toHaveCount(0)
    // The mock translator marks what it translated with the target's tag.
    await expect(spanish.getByTestId('front-other-title')).toHaveText(`en:${FRESH.es.titles[0]}`)
    await expect(spanish.getByTestId('front-other-title')).toHaveAttribute('lang', 'en')

    await page.getByTestId('titles-translated').click()
    await expect(page).toHaveURL(/\/\?titles=translated$/)
    await expect(spanish.getByTestId('front-title')).toHaveText(`en:${FRESH.es.titles[0]}`)
    await expect(spanish.getByTestId('front-title')).toHaveAttribute('lang', 'en')
    await expect(spanish.getByTestId('front-other-title')).toHaveText(FRESH.es.titles[0])
    await expect(spanish.getByTestId('front-other-title')).toHaveAttribute('lang', 'es')
    // A post in the reader's own language has the one title either way.
    const english = page.locator('article', { hasText: FRESH.en.titles[0] })
    await expect(english.getByTestId('front-other-title')).toHaveCount(0)

    await page.getByTestId('titles-original').click()
    await expect(page).toHaveURL(/\/$/)
    await expect(spanish.getByTestId('front-title')).toHaveAttribute('lang', 'es')
    // A visitor's post opens on the blog itself.
    await expect(spanish.getByTestId('front-title').getByRole('link')).toHaveAttribute(
      'href',
      `${FIXTURES}/fresh/es/1`,
    )
  })
})

test.describe('the language in the address (ADR 0060)', () => {
  test.use(VISITOR)

  test('?hl= renders a page in its language, and the app takes it over in the same words', async ({
    page,
    context,
  }) => {
    // A cookie that says otherwise, and a browser in English: the address wins for a visitor.
    await context.addCookies([{ name: 'tela_locale', value: 'zh-Hans', url: BASE }])
    // Every language the page and its first tab were in, from the first byte to the app's last
    // render: a flash of another language would show here.
    await page.addInitScript(() => {
      const seen: string[] = []
      ;(window as unknown as { seen: string[] }).seen = seen
      const note = () => {
        const tab = document.querySelector('[data-testid="discover-tab-week"]')?.textContent
        seen.push(`${document.documentElement?.lang}|${tab ?? ''}`)
      }
      new MutationObserver(note).observe(document, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
        attributeFilter: ['lang'],
      })
    })
    const booted = page.waitForResponse((res) => new URL(res.url()).pathname === '/api/v1/me')
    const res = await page.goto('/discover?hl=fr')
    expect(res?.status()).toBe(200)
    expect(res?.headers()['content-language']).toBe('fr')
    expect(res?.headers().vary).toBe('cookie')
    const html = (await res?.text()) ?? ''
    expect(html).toContain('<html lang="fr"')
    expect(html).toContain(`<link rel="canonical" href="${BASE}/discover?hl=fr" />`)
    expect(html).toContain(`hreflang="x-default" href="${BASE}/discover"`)
    expect(html).toContain(`<meta property="og:image" content="${BASE}/og/fr.png" />`)
    await booted
    await expect(page.locator('html')).toHaveAttribute('lang', 'fr')
    await expect(page.getByTestId('discover-tab-week')).toHaveText('Cette semaine')
    await expect(page).toHaveTitle('Découvrir · Tela')
    const seen = await page.evaluate(() => (window as unknown as { seen: string[] }).seen)
    expect(seen.length).toBeGreaterThan(0)
    expect(seen.filter((s) => !/^fr\|(Cette semaine)?$/.test(s))).toEqual([])

    // The app keeps the language as it goes, though the next address fixes none.
    await page.getByTestId('discover-tab-readers').click()
    await expect(page).toHaveURL(`${BASE}/discover/readers`)
    await expect(page.getByTestId('discover-tab-readers')).toHaveText('Lecteurs')
    await expect(page.locator('html')).toHaveAttribute('lang', 'fr')
    // And the address chose nothing for next time: the cookie is as it was.
    const cookie = (await context.cookies()).find((c) => c.name === 'tela_locale')
    expect(cookie?.value).toBe('zh-Hans')
  })

  test('a language Tela has no interface in fixes nothing', async ({ page }) => {
    const res = await page.goto('/discover?hl=de')
    expect(await res?.text()).toContain('<html lang="en"')
    expect(res?.headers().vary).toBe('cookie, accept-language')
  })
})

test.describe('for a member', () => {
  test("?hl= is a visitor's: a member reads in their own language", async ({ page }) => {
    const booted = page.waitForResponse((res) => new URL(res.url()).pathname === '/api/v1/me')
    const res = await page.goto('/discover?hl=fr')
    expect(await res?.text()).toContain('<html lang="en"')
    await booted
    await expect(page.getByTestId('discover-tab-week')).toHaveText('This week')
    await expect(page.locator('html')).toHaveAttribute('lang', 'en')
  })

  test('the front page is the app, which takes them to their reading', async ({ page }) => {
    const res = await page.goto('/')
    expect(res?.headers().vary).toContain('cookie')
    expect(await res?.text()).not.toContain('tela-data')
    await expect(page).toHaveURL(/\/reading$/)
  })
})

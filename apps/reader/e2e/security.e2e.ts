/**
 * The response headers (ADR 0051) as the stack serves them: the shell from the asset router
 * (`public/_headers`), the pages the Worker renders, a hashed script a day in the browser, and no
 * page a member or a visitor opens breaking the content security policy, which is report-only
 * while it proves itself, so only the page's `securitypolicyviolation` events say so.
 */
import { expect, type Page, test } from '@playwright/test'
import { SECURITY_HEADERS } from '../worker/security'
import { synced } from './helpers'

const VISITOR = { storageState: { cookies: [], origins: [] } }

function expectSecure(headers: Record<string, string>, what: string) {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    expect(headers[name], `${name} on ${what}`).toBe(value)
  }
}

/** Gather every policy violation the page reports, from before its first script runs. */
async function watchViolations(page: Page) {
  await page.addInitScript(() => {
    const seen: string[] = []
    Object.assign(window, { __violations: seen })
    document.addEventListener('securitypolicyviolation', (e) =>
      seen.push(`${e.effectiveDirective} ${e.blockedURI}`),
    )
  })
}

const violations = (page: Page) =>
  page.evaluate(() => (window as unknown as { __violations?: string[] }).__violations ?? [])

test('the shell, the pages the Worker renders and a hashed script carry their headers', async ({
  request,
}) => {
  // The shell, from the asset router: the Worker never runs for /reading.
  const shell = await request.get('/reading')
  expectSecure(shell.headers(), '/reading')
  // A page the Worker renders.
  expectSecure((await request.get('/discover/blogs')).headers(), '/discover/blogs')
  expectSecure((await request.get('/about')).headers(), '/about')
  // A hashed script: a day, not a year.
  const script = (await shell.text()).match(/<script[^>]*\ssrc="(\/assets\/[^"]+\.js)"/)?.[1]
  expect(script).toBeTruthy()
  const asset = await request.get(script ?? '')
  expect(asset.headers()['cache-control']).toBe('public, max-age=86400')
  expect(asset.headers()['x-content-type-options']).toBe('nosniff')
})

test("a member's pages break none of the policy", async ({ page }) => {
  await watchViolations(page)
  await page.goto('/reading')
  await synced(page)
  await expect(page.getByTestId('article-row').first()).toBeVisible()
  await page.getByTestId('article-row').first().click()
  await expect(page.locator('.article-body').first()).toBeVisible()
  expect(await violations(page)).toEqual([])
  for (const path of ['/discover', '/discover/blogs', '/settings', '/about']) {
    await page.goto(path)
    await page.waitForLoadState('networkidle')
    expect([path, await violations(page)]).toEqual([path, []])
  }
})

test.describe('for a visitor', () => {
  test.use(VISITOR)

  test('the pages the edge renders break none of the policy', async ({ page }) => {
    await watchViolations(page)
    for (const path of ['/', '/discover/blogs', '/about', '/join']) {
      const res = await page.goto(path)
      expectSecure(res?.headers() ?? {}, path)
      await page.waitForLoadState('networkidle')
      expect([path, await violations(page)]).toEqual([path, []])
    }
  })
})

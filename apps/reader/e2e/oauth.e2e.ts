/**
 * Google and GitHub through the whole stack (ADR 0036), as far as a test can take them: the sheet's
 * start through the edge, the state cookie's round trip, tela-api's callback and the sheet's word
 * for what came back. GitHub itself is never reached: its authorize page is answered here, as a
 * visitor who cancels would be. The token exchange, which needs the real provider, is the bun
 * suite's (`apps/api/test/oauth.test.ts`). The stack gives tela-api fake client ids, so both
 * buttons show.
 */
import { expect, test } from '@playwright/test'
import { BASE } from './helpers'

test.use({
  storageState: { cookies: [], origins: [] },
  extraHTTPHeaders: { 'cf-connecting-ip': '198.51.100.50' },
})

test('GitHub: the sheet sends the visitor there with Tela’s callback, and says so when they cancel', async ({
  page,
}) => {
  let authorize: URL | null = null
  await page.route('https://github.com/login/oauth/authorize**', async (route) => {
    const asked = new URL(route.request().url())
    authorize = asked
    const back = new URL('/api/auth/callback/github', BASE)
    back.searchParams.set('error', 'access_denied')
    back.searchParams.set('state', asked.searchParams.get('state') ?? '')
    await route.fulfill({ status: 302, headers: { location: back.toString() } })
  })

  await page.goto('/discover?topic=tech')
  await page.getByTestId('nav-login').click()
  const sheet = page.getByTestId('front-door')
  await sheet.getByTestId('door-github').click()

  // Back on the page it started on, with the sheet open again and the address as it was: the
  // Blogs page, which the old address redirects to (ADR 0044).
  await expect(sheet.getByTestId('door-error')).toHaveText('Sign-in was cancelled.')
  await expect(page).toHaveURL(/\/discover\/blogs\?topic=tech$/)
  const asked = authorize as URL | null
  expect(asked?.searchParams.get('redirect_uri')).toBe(`${BASE}/api/auth/callback/github`)
  // The state is what ties the callback to this browser's start; a missing one would have come
  // back as "took too long", not as the cancel.
  expect(asked?.searchParams.get('state')?.length ?? 0).toBeGreaterThanOrEqual(16)
  // Still a visitor.
  expect((await page.request.get('/api/v1/me')).status()).toBe(401)
})

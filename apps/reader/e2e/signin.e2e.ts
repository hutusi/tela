/**
 * Signing in with an emailed code (ADR 0024), in a browser, from nothing: the code typed into the
 * form, and the mail's link opened on another device. There is no other way in.
 */
import { type BrowserContext, expect, type Page, test } from '@playwright/test'
import {
  addFeed,
  cycle,
  FIXTURES,
  inviteAndReadCode,
  latestCode,
  memberHeaders,
  signInRequest,
} from './helpers'

test.use({ storageState: { cookies: [], origins: [] } })

/**
 * Sign-in allows three tries a minute per address (better-auth, keyed on CF-Connecting-IP), and
 * the whole suite comes from 127.0.0.1. Each test is its own visitor; in production Cloudflare
 * sets the header itself.
 */
const visitor = (n: number) => ({ extraHTTPHeaders: { 'cf-connecting-ip': `198.51.100.${n}` } })

test.describe('by code', () => {
  test.use(visitor(1))
  test('a member signs in with the code from their mail, and a wrong code says so', async ({
    page,
    request,
  }) => {
    const email = `newcomer-${Date.now()}@e2e.test`
    await inviteAndReadCode(request, email)

    await page.goto('/reading')
    await expect(page).toHaveURL(/\/login\?next=%2Freading$/)
    await page.getByTestId('login-email').fill(email)
    await page.getByTestId('login-submit').click()
    await expect(page.getByTestId('login-code')).toBeVisible()

    await page.getByTestId('login-code').fill('000000')
    await page.getByTestId('login-submit').click()
    await expect(page.getByTestId('login-form')).toContainText('That code is wrong or has expired.')

    await page.getByTestId('login-code').fill(await latestCode(request, email))
    await page.getByTestId('login-submit').click()
    await expect(page).toHaveURL(/\/reading$/)
    // A new member follows nothing yet.
    await expect(page.getByTestId('empty-state')).toBeVisible()

    await page.getByTestId('sign-out').click()
    await expect(page).toHaveURL(/\/$/)
    await page.goto('/reading')
    await expect(page).toHaveURL(/\/login/)
  })
})

test.describe('by link', () => {
  test.use(visitor(2))
  test("the mail's link signs in whichever browser opens it, and leaves no code in the address bar", async ({
    page,
    request,
  }) => {
    const email = `linked-${Date.now()}@e2e.test`
    const code = await inviteAndReadCode(request, email)
    await page.goto(`/login?email=${encodeURIComponent(email)}&otp=${code}&next=%2Fsettings`)
    await expect(page).toHaveURL(/\/settings$/)
    await expect(page.getByTestId('settings-form')).toBeVisible()
    expect(page.url()).not.toContain('otp=')
  })
})

/**
 * One browser, two accounts: `page` signed in as the first, following a fixture feed, open at
 * `path`; then the second signed in (the cookie is the whole browser's) and open in another tab.
 * `page` is left in front, still showing the first account.
 */
async function twoAccounts(
  page: Page,
  context: BrowserContext,
  path: '/reading' | '/settings' = '/reading',
): Promise<{ other: Page }> {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  await signInRequest(context.request, `first-${stamp}@e2e.test`)
  await addFeed(context.request, `${FIXTURES}/jnito.xml`)
  await cycle(context.request)
  await page.goto('/reading')
  await expect(page.getByTestId('subscription')).toHaveCount(1)
  if (path === '/settings') {
    await page.goto('/settings')
    await expect(page.getByTestId('settings-form')).toBeVisible()
  }

  const other = await context.newPage()
  await signInRequest(context.request, `second-${stamp}@e2e.test`)
  await other.goto('/reading')
  await expect(other.getByTestId('empty-state')).toBeVisible()
  await page.bringToFront()
  return { other }
}

/** A sync the page makes from now on, answered: only a tab holding the session's account gets one. */
const nextSync = (page: Page) =>
  page.waitForResponse((r) => new URL(r.url()).pathname === '/api/v1/sync' && r.ok())

test.describe('two accounts in one browser', () => {
  test.use(visitor(3))
  test('a tab still holding one account starts over when another tab signs in as someone else', async ({
    page,
    context,
  }) => {
    await twoAccounts(page, context)

    // The first tab still shows the first account. Opening a post reads it; the device will not
    // keep that change for the second account, and the tab starts over as them.
    const resynced = nextSync(page)
    await page.getByTestId('article-row').first().click()
    await expect(page.getByTestId('subscription')).toHaveCount(0)
    // Its first sync as the second account, and any push that would go with it, are done.
    await resynced
    await page.waitForLoadState('networkidle')

    // A check that could see the leak: once the second account follows the same feed, a
    // snapshot carries their read state for its posts. The one opened in the stale tab is unread.
    await addFeed(context.request, `${FIXTURES}/jnito.xml`)
    const pulled = await (
      await context.request.get('/api/v1/sync?cursor=0', {
        headers: await memberHeaders(context.request),
      })
    ).json()
    expect(pulled.rows.subscriptions).toHaveLength(1)
    expect(pulled.rows.states).toEqual([])
  })
})

test.describe('a stale tab saving settings', () => {
  test.use(visitor(4))
  test("changes nothing of the other account's, and starts over as them", async ({
    page,
    context,
  }) => {
    await twoAccounts(page, context, '/settings')
    const profileNow = async () =>
      ((await (await context.request.get('/api/v1/me')).json()) as { profile: unknown }).profile
    const before = await profileNow()

    await page.getByTestId('settings-handle').fill(`stale${Date.now().toString(36)}`)
    await page.getByTestId('settings-display-name').fill('Stale Tab')
    await page.getByTestId('settings-save').click()
    // Refused as a call for another account than the session's: the tab starts again from '/',
    // which sends the member signed in now to their reading.
    await expect(page).toHaveURL(/\/reading$/)
    await expect(page.getByTestId('empty-state')).toBeVisible()
    expect(await profileNow()).toEqual(before)
  })
})

test.describe('a stale tab signing out', () => {
  test.use(visitor(5))
  test('leaves the other account signed in, and its tab still syncing', async ({
    page,
    context,
  }) => {
    const { other } = await twoAccounts(page, context)
    const resynced = nextSync(page)
    await page.getByTestId('sign-out').click()
    // The session is the second account's: this tab forgets the first and starts over as the
    // second, rather than end a session that is not its own.
    await expect(page.getByTestId('empty-state')).toBeVisible()
    expect((await context.request.get('/api/v1/me')).status()).toBe(200)
    await resynced

    const synced = nextSync(other)
    await other.reload()
    await synced
    await expect(other.getByTestId('empty-state')).toBeVisible()
  })
})

/**
 * Signing in with an emailed code (ADR 0024), in a browser, from nothing: the code typed into the
 * form, and the mail's link opened on another device. There is no other way in.
 */
import { expect, test } from '@playwright/test'
import { addFeed, cycle, FIXTURES, inviteAndReadCode, latestCode, signInRequest } from './helpers'

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

test.describe('two accounts in one browser', () => {
  test.use(visitor(3))
  test('a tab still holding one account starts over when another tab signs in as someone else', async ({
    page,
    context,
  }) => {
    const first = `first-${Date.now()}@e2e.test`
    const second = `second-${Date.now()}@e2e.test`
    await signInRequest(context.request, first)
    await addFeed(context.request, `${FIXTURES}/jnito.xml`)
    await cycle(context.request)
    await page.goto('/reading')
    await expect(page.getByTestId('subscription')).toHaveCount(1)

    // Another tab signs in as someone else; the cookie is the whole browser's.
    const other = await context.newPage()
    await signInRequest(context.request, second)
    await other.goto('/reading')
    await expect(other.getByTestId('empty-state')).toBeVisible()

    // The first tab still shows the first account. Opening a post reads it, and that change
    // would have been pushed with the second account's cookie.
    await page.bringToFront()
    await page.getByTestId('article-row').first().click()
    // It is refused instead, and the tab starts over as the second account, who follows nothing.
    await expect(page.getByTestId('subscription')).toHaveCount(0)
    const pulled = await (
      await context.request.get('/api/v1/sync?cursor=0', { headers: { 'x-tela-client': '1' } })
    ).json()
    expect(pulled.rows.states).toEqual([])
    expect(pulled.rows.subscriptions).toEqual([])
  })
})

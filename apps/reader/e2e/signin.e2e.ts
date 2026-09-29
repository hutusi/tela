/**
 * Signing in with an emailed code (ADR 0024), in a browser, from nothing: the code typed into the
 * form, and the mail's link opened on another device. There is no other way in.
 */
import { expect, test } from '@playwright/test'
import { inviteAndReadCode, latestCode } from './helpers'

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

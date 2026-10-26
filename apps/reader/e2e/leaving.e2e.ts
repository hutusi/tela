/**
 * Deleting an account from Settings (ADR 0058): the dialog says what goes and what stays, asks for
 * a code mailed to the member, and once it is entered this tab starts over signed out while
 * another device holding the same session is refused from its next call.
 */
import { expect, test } from '@playwright/test'
import { BASE, latestCode, signInRequest } from './helpers'

test.use({ storageState: { cookies: [], origins: [] } })

test('a member deletes their account, and every device is signed out', async ({
  browser,
  request,
}) => {
  const email = `leaver-${Date.now()}@e2e.test`
  // Browsers of their own, from addresses of their own: better-auth allows three sign-in tries a
  // minute per address, and the whole suite comes from 127.0.0.1.
  const here = await browser.newContext({
    baseURL: BASE,
    extraHTTPHeaders: { 'cf-connecting-ip': '203.0.113.58' },
  })
  await signInRequest(here.request, email)
  // Another device with the same session: its cookies, a signed copy of the session included.
  const there = await browser.newContext({
    baseURL: BASE,
    storageState: await here.storageState(),
    extraHTTPHeaders: { 'cf-connecting-ip': '203.0.113.59' },
  })
  const away = await there.newPage()
  await away.goto('/reading')
  await expect(away.getByTestId('account-menu')).toBeVisible()

  const page = await here.newPage()
  await page.goto('/settings/account')
  await page.getByTestId('account-delete').click()
  const dialog = page.getByTestId('account-delete-dialog')
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText('is retired, so nobody can take it')
  await expect(dialog).toContainText('30 days')

  await page.getByTestId('account-delete-send').click()
  await page.getByTestId('account-delete-code').fill('000000')
  await page.getByTestId('account-delete-confirm').click()
  // A wrong code is said so, and nothing is deleted (one code in a million is this one).
  await expect(page.getByTestId('account-delete-error')).toBeVisible()
  await page.getByTestId('account-delete-code').fill(await latestCode(request, email))
  await page.getByTestId('account-delete-confirm').click()
  await expect(page).toHaveURL(`${BASE}/`)
  await page.goto('/reading')
  await expect(page).toHaveURL(/\/login/)

  // The other device: the next call that matters is refused, and it starts over signed out.
  expect((await there.request.get('/api/v1/me')).status()).toBe(401)
  await away.reload()
  await expect(away).toHaveURL(/\/login/)

  // Nobody can sign in to it again: no code is mailed to its address.
  const before = (await (await request.get(`/api/test/outbox?email=${email}`)).json()) as unknown[]
  await page.goto('/login')
  await page.getByTestId('login-mode').click()
  await page.getByTestId('login-email').fill(email)
  await page.getByTestId('login-submit').click()
  await expect(page.getByTestId('login-code')).toBeVisible()
  const after = (await (await request.get(`/api/test/outbox?email=${email}`)).json()) as unknown[]
  expect(after).toHaveLength(before.length)
  await here.close()
  await there.close()
})

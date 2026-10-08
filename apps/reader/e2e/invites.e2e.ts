/**
 * Settings → Invites and Settings → Account (ADR 0034): a member makes a code and sends its link,
 * a visitor joins with it, and the member sees who joined; a member sets a password in Settings and
 * then logs in with it. Each member here is new, so no other spec's codes count against its five.
 */
import { type Browser, type BrowserContext, expect, type Page, test } from '@playwright/test'
import { BASE, fromAccountMenu, latestCode, signInRequest } from './helpers'

test.use({ storageState: { cookies: [], origins: [] } })

/**
 * A browser of its own, from its own address: better-auth allows three sign-in tries a minute per
 * address, and the whole suite comes from 127.0.0.1.
 */
async function visitor(browser: Browser, n: number): Promise<BrowserContext> {
  return browser.newContext({
    baseURL: BASE,
    extraHTTPHeaders: { 'cf-connecting-ip': `203.0.113.${n}` },
  })
}

/** A new member, signed in by the code flow, on a page of their own. */
async function member(browser: Browser, n: number, email: string): Promise<Page> {
  const context = await visitor(browser, n)
  await signInRequest(context.request, email)
  return context.newPage()
}

test('a member makes a code, a visitor joins with its link, and the member sees who joined', async ({
  browser,
  request,
}) => {
  const stamp = Date.now()
  const inviter = await member(browser, 1, `inviter-${stamp}@e2e.test`)

  await inviter.goto('/reading')
  await fromAccountMenu(inviter, 'nav-invites')
  await expect(inviter).toHaveURL(/\/settings\/invites$/)
  await expect(inviter.getByTestId('invites-left')).toHaveText('You can invite 5 more people.')

  await inviter.getByTestId('invite-create').click()
  const invite = inviter.getByTestId('invite').first()
  await expect(invite).toHaveAttribute('data-status', 'unused')
  await expect(inviter.getByTestId('invites-left')).toHaveText('You can invite 4 more people.')
  const link = (await inviter.getByTestId('invite-link').first().textContent()) ?? ''
  expect(link).toMatch(/\/join\?code=[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/)

  // The visitor opens the link: the join sheet has the code, and asks for an address.
  const guest = await (await visitor(browser, 2)).newPage()
  const email = `joiner-${stamp}@e2e.test`
  const url = new URL(link)
  await guest.goto(url.pathname + url.search)
  await expect(guest.getByTestId('join-code')).toHaveValue(url.searchParams.get('code') ?? '')
  await guest.getByTestId('login-email').fill(email)
  await guest.getByTestId('login-submit').click()
  await expect(guest.getByTestId('login-code')).toBeVisible()
  await guest.getByTestId('login-code').fill(await latestCode(request, email))
  await guest.getByTestId('login-submit').click()
  await expect(guest).toHaveURL(/\/discover/)
  // The menu is drawn once the session is known; its handle comes with the first pull after.
  const menu = guest.getByTestId('account-menu')
  await expect(menu).toHaveAttribute('data-handle', /.+/)
  const handle = await menu.getAttribute('data-handle')
  expect(handle).toBeTruthy()

  // The inviter's list says who joined, by handle, and the code still counts.
  await inviter.reload()
  await expect(invite).toHaveAttribute('data-status', 'joined')
  await expect(inviter.getByTestId('invite-status').first()).toHaveText(`@${handle} joined`)
  await expect(inviter.getByTestId('invite-revoke')).toHaveCount(0)
  await expect(inviter.getByTestId('invites-left')).toHaveText('You can invite 4 more people.')

  // An unused code can be revoked, which gives its place back.
  await inviter.getByTestId('invite-create').click()
  await expect(inviter.getByTestId('invites-left')).toHaveText('You can invite 3 more people.')
  await inviter.getByTestId('invite-revoke').click()
  await expect(inviter.getByTestId('invite')).toHaveCount(1)
  await expect(inviter.getByTestId('invites-left')).toHaveText('You can invite 4 more people.')
})

test('a member sets a password in Settings, then logs in with it', async ({ browser }) => {
  const email = `password-${Date.now()}@e2e.test`
  const password = 'correct horse battery'
  const page = await member(browser, 3, email)

  await page.goto('/settings/account')
  await expect(page.getByTestId('account-email')).toHaveText(email)
  await expect(page.getByTestId('account-password-state')).toHaveText(
    'Not set. You sign in with an emailed code.',
  )
  // Just signed in, so the session is fresh: nothing asks to confirm it is them.
  await expect(page.getByTestId('account-confirm-box')).toHaveCount(0)

  await page.getByTestId('account-password-open').click()
  await expect(page.getByTestId('account-password-current')).toHaveCount(0)
  await page.getByTestId('account-password-new').fill(password)
  await page.getByTestId('account-password-save').click()
  await expect(page.getByTestId('account-password-saved')).toBeVisible()
  await expect(page.getByTestId('account-password-state')).toHaveText(
    'Set. You can still sign in with an emailed code.',
  )

  await fromAccountMenu(page, 'sign-out')
  await expect(page).toHaveURL(/\/$/)

  // The log-in sheet, by password this time.
  await page.goto('/login')
  await page.getByTestId('login-email').fill(email)
  await page.locator('input[type="password"]').fill(password)
  await page.getByTestId('login-submit').click()
  await expect(page).toHaveURL(/\/reading$/)
})

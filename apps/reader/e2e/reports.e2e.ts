/**
 * Reports and suspension (ADR 0059): a visitor's Report is a mail with the page in it; a member's
 * opens a sheet, which sends the report and thanks them; the operator finds it in the console's
 * Reports queue, suspends the member from its record, and resolves it.
 */
import { type Browser, expect, type Page, test } from '@playwright/test'
import { ADMIN_TOKEN, BASE, memberHeaders, signInRequest } from './helpers'

test.use({ storageState: { cookies: [], origins: [] } })

const ORIGIN = { origin: BASE }
const HANDLE = 'spam_e2e'
let spammer = ''

/** A new member on a page of their own, from an address of their own, granted the console when `admin`. */
async function member(browser: Browser, n: number, admin = false): Promise<Page> {
  const context = await browser.newContext({
    baseURL: BASE,
    extraHTTPHeaders: { 'cf-connecting-ip': `192.0.2.${n}` },
  })
  const email = `reports-${n}-${Date.now()}@e2e.test`
  await signInRequest(context.request, email)
  if (admin) {
    const granted = await context.request.post(`${BASE}/api/admin/admins`, {
      headers: { ...ORIGIN, authorization: `Bearer ${ADMIN_TOKEN}` },
      data: { email, admin: true },
    })
    expect(granted.ok()).toBe(true)
  }
  return context.newPage()
}

test.beforeAll(async ({ browser }) => {
  const page = await member(browser, 81)
  const named = await page.request.put(`${BASE}/api/v1/profile`, {
    headers: { ...ORIGIN, ...(await memberHeaders(page.request)) },
    data: { handle: HANDLE, displayName: 'Growth Course', bio: '10x your newsletter. Link below.' },
  })
  expect(named.ok()).toBe(true)
  spammer = ((await (await page.request.get(`${BASE}/api/v1/me`)).json()) as { id: string }).id
  await page.context().close()
})

test('a visitor reports by mail, with the page’s address in it', async ({ page }) => {
  await page.goto(`/@${HANDLE}`)
  const link = page.locator('[data-testid="report-link"][data-report="profile"]')
  await expect(link).toHaveText('Report')
  const href = (await link.getAttribute('href')) ?? ''
  expect(href.startsWith('mailto:me@hutu.si?subject=')).toBe(true)
  expect(href).toContain(`body=${encodeURIComponent(`https://telaread.com/@${HANDLE}`)}`)
})

test('a member reports from a sheet, and the operator suspends from the queue', async ({
  browser,
}) => {
  const reader = await member(browser, 82)
  await reader.goto(`/@${HANDLE}`)
  const report = reader.locator('[data-testid="report-link"][data-report="profile"]')
  // The edge's page holds a visitor's mail; the app swaps in the sheet once it knows who reads.
  await expect(report).toHaveAttribute('aria-haspopup', 'dialog')
  await report.click()
  const sheet = reader.getByTestId('report-sheet')
  await expect(sheet).toBeVisible()
  // Nothing to send until a reason is chosen.
  await expect(sheet.getByTestId('report-send')).toBeDisabled()
  await sheet.getByTestId('report-reason-spam').click()
  await sheet.getByTestId('report-details').fill('Course ads in the bio.')
  const sent = reader.waitForResponse((r) => r.url().endsWith('/api/v1/reports'))
  await sheet.getByTestId('report-send').click()
  expect((await sent).status()).toBe(200)
  await expect(sheet.getByTestId('report-thanks')).toBeVisible()
  await sheet.getByTestId('report-close').click()
  await expect(sheet).toHaveCount(0)

  const ops = await member(browser, 83, true)
  await ops.goto('/admin/reports')
  await expect(ops.locator('[data-testid="admin-nav-item"][data-area="reports"]')).toContainText(
    '1',
  )
  const row = ops.locator(`[data-testid="admin-row"][data-row-id="profile:${spammer}"]`)
  await row.click()
  const record = ops.getByTestId('admin-record')
  await expect(record).toContainText('Course ads in the bio.')
  await record.locator('[data-testid="report-target-action"][data-action="member.suspend"]').click()
  await record.getByTestId('admin-confirm-yes').click()
  await expect(ops.getByTestId('admin-toast')).toContainText('Suspended')
  // Their profile is gone from every public answer.
  expect((await ops.request.get(`${BASE}/api/v1/public/profiles/${HANDLE}`)).status()).toBe(404)

  await record.locator('[data-testid="admin-record-action"][data-action="report.resolve"]').click()
  await expect(ops.getByTestId('admin-toast')).toContainText('Resolved')
  await expect(row).toHaveCount(0)
  await reader.context().close()
  await ops.context().close()
})

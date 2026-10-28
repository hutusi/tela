/**
 * Apps members register themselves (ADR 0067), end to end: a member registers one in Settings →
 * Developer and connects it while it is in Testing, where nobody else can; makes it Live, where
 * the consent page says Tela has not reviewed it and names its developer by handle; another member
 * reports it from there, and the operator cuts it off from the report, which its token and its
 * developer's Settings both feel at once. Then a review asked for with the email permission and
 * granted from the console's queue, and the cap an unreviewed app's members are held to.
 *
 * The steps hang together, so they run in order and stop at the first that fails. Each member is
 * new and comes from an address of its own (sign-in is limited per address), so nothing here
 * reaches the member the other specs share.
 */
import {
  type APIRequestContext,
  type Browser,
  type BrowserContext,
  expect,
  type Page,
  request,
  test,
} from '@playwright/test'
import { bearer, fakeApp, refresh, type Tokens } from './fake-app'
import { ADMIN_TOKEN, BASE, GATEWAY, memberHeaders, setSetting, signInRequest } from './helpers'

test.use({ storageState: { cookies: [], origins: [] } })
test.describe.configure({ mode: 'serial' })

const ORIGIN = { origin: BASE }
const RUN = Date.now().toString(36)
/** The developer's handle: what an unreviewed app's consent page names in place of their words. */
const HANDLE = `dev_${RUN}`
/** Registered without a port: a loopback redirect matches on any port (RFC 8252 §7.3). */
const REDIRECT = 'http://127.0.0.1/callback'
/** Registered in Settings, connected in Testing, made Live, reported, and cut off. */
const FIRST = `Marginalia ${RUN}`
/** Who the developer says makes it: never shown on the consent page while it is not reviewed. */
const FIRST_BY = 'Marginalia Works'
/** Asks for a review with the email permission, and is granted both. */
const SECOND = `Commonplace ${RUN}`
const SECOND_BY = 'Commonplace Press'
/** Live and unreviewed, held to `apps.unreviewedMaxConnections`. */
const THIRD = `Waypoint ${RUN}`
const CAP = 'apps.unreviewedMaxConnections'

type Member = { context: BrowserContext; page: Page; email: string }

/** A new member on a context of their own, from an address of their own. */
async function member(browser: Browser, n: number, admin = false): Promise<Member> {
  const context = await browser.newContext({
    baseURL: BASE,
    storageState: { cookies: [], origins: [] },
    extraHTTPHeaders: { 'cf-connecting-ip': `100.64.3.${n}` },
  })
  const email = `developer-${n}-${Date.now()}@e2e.test`
  await signInRequest(context.request, email)
  if (admin) {
    const granted = await context.request.post(`${BASE}/api/admin/admins`, {
      headers: { ...ORIGIN, authorization: `Bearer ${ADMIN_TOKEN}` },
      data: { email, admin: true },
    })
    expect(granted.ok()).toBe(true)
  }
  return { context, page: await context.newPage(), email }
}

type DeveloperApp = {
  appId: number
  clientId: string
  name: string
  status: string
  reviewed: boolean
}

/** The member's own apps, as Settings → Developer reads them. */
async function myApps(api: APIRequestContext): Promise<DeveloperApp[]> {
  const res = await api.get(`${BASE}/api/v1/developer/apps`, { headers: await memberHeaders(api) })
  expect(res.ok()).toBe(true)
  return ((await res.json()) as { apps: DeveloperApp[] }).apps
}

/** Register an app as Settings → Developer sends it, and make it Live. */
async function liveApp(api: APIRequestContext, name: string, developer: string) {
  const headers = { ...ORIGIN, ...(await memberHeaders(api)) }
  const registered = await api.post(`${BASE}/api/v1/developer/apps`, {
    headers,
    data: {
      name,
      developer,
      homepageUrl: 'https://apps.example',
      privacyUrl: 'https://apps.example/privacy',
      redirectUris: [REDIRECT],
      maxScope: 'write',
      acceptTerms: true,
    },
  })
  expect(registered.status(), await registered.text()).toBe(201)
  const { app } = (await registered.json()) as { app: DeveloperApp }
  const live = await api.post(`${BASE}/api/v1/developer/apps/${app.appId}/live`, {
    headers,
    data: { live: true },
  })
  expect(live.ok(), await live.text()).toBe(true)
  return app
}

/** Approve on the consent page as the member, and exchange the code the listener caught. */
async function connect(page: Page, app: Awaited<ReturnType<typeof fakeApp>>): Promise<Tokens> {
  await page.goto(app.url)
  await expect(page.getByTestId('connect-consent')).toBeVisible()
  await page.getByTestId('connect-approve').click()
  const answer = await app.answer()
  expect(answer).toMatchObject({ state: app.state, iss: GATEWAY, error: null })
  await expect(page.locator('#fake-app')).toBeVisible()
  return app.exchange(http, answer.code ?? '')
}

/** The app's own HTTP client: no cookie, no address, nothing but what each call names. */
let http: APIRequestContext
/** Registers the apps. */
let developer: Member
/** Refused, then reports, then connects a reviewed app; refused again by the cap. */
let reader: Member
/** Takes the one place an unreviewed app's cap leaves. */
let other: Member
/** An admin: the console. */
let operator: Member
/** The first app's, and its developer's tokens from Testing. */
let clientId = ''
let developerTokens: Tokens

test.beforeAll(async ({ browser }) => {
  http = await request.newContext({ storageState: { cookies: [], origins: [] } })
  developer = await member(browser, 1)
  const named = await developer.context.request.put(`${BASE}/api/v1/profile`, {
    headers: { ...ORIGIN, ...(await memberHeaders(developer.context.request)) },
    data: { handle: HANDLE, displayName: 'Dee Veloper', bio: 'Builds small reading tools.' },
  })
  expect(named.ok(), await named.text()).toBe(true)
  reader = await member(browser, 2)
  other = await member(browser, 3)
  operator = await member(browser, 4, true)
})

test.afterAll(async () => {
  for (const m of [developer, reader, other, operator]) await m?.context.close()
  await http?.dispose()
})

test('a member registers an app in Settings: in Testing, not reviewed, its client ID at once', async () => {
  const { page } = developer
  await page.goto('/settings/developer')
  await expect(page.getByTestId('developer-none')).toBeVisible()
  await page.getByTestId('developer-register').click()
  const form = page.getByTestId('developer-form')
  await form.getByTestId('developer-form-name').fill(FIRST)
  await form.getByTestId('developer-form-developer').fill(FIRST_BY)
  // The contact address is left empty: the account's own.
  await form.getByTestId('developer-form-homepageUrl').fill('https://marginalia.example')
  await form.getByTestId('developer-form-privacyUrl').fill('https://marginalia.example/privacy')
  await form.getByTestId('developer-form-redirectUris').fill(REDIRECT)
  await form.getByTestId('developer-form-scope-write').check()
  // Not without the developer rules.
  await form.getByTestId('developer-form-submit').click()
  await expect(form.locator('[data-field-error="terms"]')).toBeVisible()
  await form.getByTestId('developer-form-terms').check()
  await form.getByTestId('developer-form-submit').click()
  await expect(form).toHaveCount(0)

  const row = page.getByTestId('developer-app').filter({ hasText: FIRST })
  await expect(row).toHaveAttribute('data-status', 'draft')
  await expect(row.getByTestId('developer-app-status')).toHaveText('Testing')
  await expect(row.getByTestId('developer-app-review')).toContainText('Not reviewed')
  const id = row.getByTestId('developer-app-client-id')
  await expect(id).toHaveText(/^tela_app_/)
  clientId = (await id.textContent()) ?? ''
  // Unreviewed apps share one cap, said once under the list.
  await expect(page.getByTestId('developer-cap')).toContainText('100 members')
})

test('in Testing, its developer connects it, and nobody else can', async () => {
  const mine = await fakeApp(clientId)
  try {
    await developer.page.goto(mine.url)
    await expect(developer.page.getByTestId('connect-consent')).toBeVisible()
    await expect(developer.page.getByTestId('connect-draft')).toBeVisible()
    await developer.page.getByTestId('connect-approve').click()
    const answer = await mine.answer()
    expect(answer).toMatchObject({ state: mine.state, iss: GATEWAY, error: null })
    await expect(developer.page.locator('#fake-app')).toBeVisible()
    developerTokens = await mine.exchange(http, answer.code ?? '')
  } finally {
    await mine.close()
  }
  expect(developerTokens.scope).toBe('write')
  const me = await http.get(`${GATEWAY}/v1/me`, { headers: bearer(developerTokens) })
  expect(me.status()).toBe(200)
  expect(((await me.json()) as { handle: string }).handle).toBe(HANDLE)

  // Anyone else is told no such app, and the browser goes nowhere.
  const theirs = await fakeApp(clientId)
  try {
    await reader.page.goto(theirs.url)
    await expect(reader.page.getByTestId('connect-error')).toHaveAttribute(
      'data-error',
      'invalid_client',
    )
    await expect(reader.page.getByTestId('connect-consent')).toHaveCount(0)
  } finally {
    await theirs.close()
  }
})

test('Live, its consent page says Tela has not reviewed it, by handle, and a member reports it', async () => {
  await developer.page.goto('/settings/developer')
  const row = developer.page.getByTestId('developer-app').filter({ hasText: FIRST })
  await row.getByTestId('developer-app-live').click()
  await expect(row).toHaveAttribute('data-status', 'approved')
  await expect(row.getByTestId('developer-app-status')).toHaveText('Live')
  // Live keeps the developer's own connection.
  expect((await http.get(`${GATEWAY}/v1/me`, { headers: bearer(developerTokens) })).status()).toBe(
    200,
  )

  const { page } = reader
  const app = await fakeApp(clientId)
  try {
    await page.goto(app.url)
    const consent = page.getByTestId('connect-consent')
    await expect(consent.getByRole('heading', { level: 1 })).toHaveText(
      `Connect ${FIRST} to your Tela account?`,
    )
    await expect(page.getByTestId('connect-draft')).toHaveCount(0)
    await expect(page.getByTestId('connect-unreviewed')).toContainText('Not reviewed by Tela')
    // Named by the handle Tela vouches for, never the words its developer typed.
    await expect(consent).toContainText(`By @${HANDLE}`)
    await expect(consent).not.toContainText(FIRST_BY)

    const report = page.locator('[data-testid="report-link"][data-report="app"]')
    await expect(report).toHaveAttribute('aria-haspopup', 'dialog')
    await report.click()
    const sheet = page.getByTestId('report-sheet')
    await expect(sheet.getByRole('heading', { level: 2 })).toHaveText('Report this app')
    await sheet.getByTestId('report-reason-impersonation').click()
    await sheet.getByTestId('report-details').fill('It says it is the official Tela client.')
    const sent = page.waitForResponse((r) => r.url().endsWith('/api/v1/reports'))
    await sheet.getByTestId('report-send').click()
    expect((await sent).status()).toBe(200)
    await expect(sheet.getByTestId('report-thanks')).toBeVisible()
    await sheet.getByTestId('report-close').click()
    await expect(sheet).toHaveCount(0)
    // The request is still the member's to answer.
    await expect(consent).toBeVisible()
  } finally {
    await app.close()
  }
})

test('the operator cuts the app off from the report: its token is refused, its Settings say so', async () => {
  const { page } = operator
  await page.goto('/admin/reports')
  const row = page.locator(`[data-testid="admin-row"][data-row-id="app:${clientId}"]`)
  await row.click()
  const record = page.getByTestId('admin-record')
  await expect(record).toContainText('It says it is the official Tela client.')
  await expect(record).toContainText(`@${HANDLE}`)
  await record.locator('[data-testid="report-target-action"][data-action="app.suspend"]').click()
  await page.getByTestId('admin-confirm-yes').click()
  await expect(page.getByTestId('admin-toast')).toContainText('Cut off')

  // Every call refused from the next one, and no refresh either.
  const refused = await http.get(`${GATEWAY}/v1/me`, { headers: bearer(developerTokens) })
  expect(refused.status()).toBe(403)
  expect(await refused.json()).toEqual({ error: 'app_suspended' })
  expect(await refresh(http, clientId, developerTokens.refresh_token)).toEqual({
    status: 400,
    error: 'unauthorized_client',
  })

  // The developer sees it cut off, with nothing left to change.
  await developer.page.goto('/settings/developer')
  const mine = developer.page.getByTestId('developer-app').filter({ hasText: FIRST })
  await expect(mine).toHaveAttribute('data-status', 'suspended')
  await expect(mine.getByTestId('developer-app-status')).toHaveText('Cut off')
  await expect(mine.getByTestId('developer-app-actions')).toHaveCount(0)

  // Acted on: resolved, and the queue is empty again for whoever reads it next.
  await record.locator('[data-testid="admin-record-action"][data-action="report.resolve"]').click()
  await expect(page.getByTestId('admin-toast')).toContainText('Resolved')
  await expect(row).toHaveCount(0)
})

test('an app asks for a review with email; reviewed from the queue, its consent page asks for the address', async () => {
  const second = await liveApp(developer.context.request, SECOND, SECOND_BY)
  await developer.page.goto('/settings/developer')
  const row = developer.page.getByTestId('developer-app').filter({ hasText: SECOND })
  await row.getByTestId('developer-app-review-ask').click()
  const ask = row.getByTestId('developer-app-review-form')
  await ask.getByTestId('developer-review-note').fill('Sends a weekly digest of saved posts.')
  await ask.getByTestId('developer-review-email').check()
  await ask.getByTestId('developer-review-send').click()
  await expect(ask).toHaveCount(0)
  await expect(row.getByTestId('developer-app-review')).toContainText('review requested')
  await expect(row.getByTestId('developer-app-review-ask')).toHaveCount(0)

  // Unreviewed, the address is never offered, whatever the app asks.
  const before = await fakeApp(second.clientId, 'write email')
  try {
    await reader.page.goto(before.url)
    await expect(reader.page.getByTestId('connect-unreviewed')).toBeVisible()
    await expect(reader.page.getByTestId('connect-email')).toHaveCount(0)
  } finally {
    await before.close()
  }

  const { page } = operator
  await page.goto('/admin/apps')
  await page.locator('[data-testid="admin-filter"][data-filter="review"]').click()
  await page.getByTestId('admin-row').filter({ hasText: SECOND }).click()
  const record = page.getByTestId('admin-record')
  await expect(record.getByTestId('admin-app-request')).toContainText(
    'Sends a weekly digest of saved posts.',
  )
  await record.locator('[data-testid="admin-record-action"][data-action="app.review"]').click()
  const review = page.locator('[data-testid="admin-input"][data-kind="review"]')
  // It starts from what the developer asked for.
  await expect(review.getByTestId('app-review-email')).toBeChecked()
  await review.getByTestId('admin-input-submit').click()
  await expect(page.getByTestId('admin-toast')).toContainText('Reviewed')
  await expect
    .poll(
      async () =>
        (await myApps(developer.context.request)).find((a) => a.clientId === second.clientId)
          ?.reviewed,
    )
    .toBe(true)

  const app = await fakeApp(second.clientId, 'write email')
  try {
    await reader.page.goto(app.url)
    const consent = reader.page.getByTestId('connect-consent')
    await expect(consent).toBeVisible()
    await expect(reader.page.getByTestId('connect-unreviewed')).toHaveCount(0)
    // Reviewed, it is named by its developer's own words.
    await expect(consent).toContainText(`By ${SECOND_BY}`)
    await expect(reader.page.getByTestId('connect-email')).toBeChecked()
    await reader.page.getByTestId('connect-approve').click()
    const answer = await app.answer()
    expect(answer).toMatchObject({ state: app.state, iss: GATEWAY, error: null })
    await expect(reader.page.locator('#fake-app')).toBeVisible()
    const tokens = await app.exchange(http, answer.code ?? '')
    expect(tokens.scope).toBe('write email')
    const me = await http.get(`${GATEWAY}/v1/me`, { headers: bearer(tokens) })
    expect(((await me.json()) as { email?: string }).email).toBe(reader.email)
  } finally {
    await app.close()
  }
})

test('an unreviewed app holds no more members than its cap, its developer aside', async () => {
  const settings = await operator.context.request.get(`${BASE}/api/admin/settings`, {
    headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
  })
  expect(settings.ok()).toBe(true)
  const was = (
    (await settings.json()) as { settings: { key: string; value: unknown }[] }
  ).settings.find((s) => s.key === CAP)?.value
  expect(was).not.toBeUndefined()
  // The stack is shared by every spec: the cap goes back however this ends.
  await setSetting(operator.context.request, CAP, 1)
  try {
    const third = await liveApp(developer.context.request, THIRD, 'Waypoint')
    const first = await fakeApp(third.clientId)
    try {
      expect((await connect(other.page, first)).scope).toBe('write')
    } finally {
      await first.close()
    }

    const second = await fakeApp(third.clientId)
    try {
      await reader.page.goto(second.url)
      await expect(reader.page.getByTestId('connect-error')).toHaveAttribute(
        'data-error',
        'max_connections',
      )
      await expect(reader.page.getByTestId('connect-consent')).toHaveCount(0)
      // Its developer's own connection never counts, so they are still asked.
      await developer.page.goto(second.url)
      await expect(developer.page.getByTestId('connect-consent')).toBeVisible()
    } finally {
      await second.close()
    }
  } finally {
    await setSetting(operator.context.request, CAP, was)
  }
})

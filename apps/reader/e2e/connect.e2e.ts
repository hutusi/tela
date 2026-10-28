/**
 * Connecting an approved app (ADRs 0064, 0065), as a desktop app does it: a listener on a free
 * loopback port, the member's browser sent to `/connect` with a PKCE challenge and a state, the
 * answer caught at the listener, the code exchanged at tela-gateway (api.telaread.com's stand-in),
 * and the v1 API called with the token. Then what a member and the operator do to it: Disconnect in
 * Settings, decline, lower the level, sign in on the way, and cut the app off in the console.
 *
 * Each member here is new and comes from an address of its own (sign-in is limited per address),
 * so nothing an app does reaches the member the other specs share.
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
import { bearer, type FakeApp, fakeApp, refresh, type Tokens } from './fake-app'
import {
  ADMIN_TOKEN,
  addFeed,
  BASE,
  cycle,
  FIXTURES,
  GATEWAY,
  inviteAndReadCode,
  latestCode,
  memberHeaders,
  readStateOnServer,
  signInRequest,
} from './helpers'

test.use({ storageState: { cookies: [], origins: [] } })

const ORIGIN = { origin: BASE }
/** Registered without a port: a loopback redirect matches on any port (RFC 8252 §7.3). */
const REDIRECT = 'http://127.0.0.1/callback'
/** The app the operator registered and approved for this spec, by `beforeAll`. */
const APP = `Fieldnotes ${Date.now().toString(36)}`

/** A new member on a context of their own, from an address of their own. */
async function member(
  browser: Browser,
  n: number,
  options: { admin?: boolean; feeds?: string[] } = {},
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({
    baseURL: BASE,
    storageState: { cookies: [], origins: [] },
    extraHTTPHeaders: { 'cf-connecting-ip': `100.64.1.${n}` },
  })
  const email = `connect-${n}-${Date.now()}@e2e.test`
  await signInRequest(context.request, email)
  if (options.admin) {
    const granted = await context.request.post(`${BASE}/api/admin/admins`, {
      headers: { ...ORIGIN, authorization: `Bearer ${ADMIN_TOKEN}` },
      data: { email, admin: true },
    })
    expect(granted.ok()).toBe(true)
  }
  for (const path of options.feeds ?? []) await addFeed(context.request, `${FIXTURES}${path}`)
  return { context, page: await context.newPage() }
}

/** An action in the console's API, as the console sends it (ADR 0039). */
async function act(
  api: APIRequestContext,
  action: string,
  ids: string[],
  args: Record<string, unknown> = {},
): Promise<void> {
  const res = await api.post(`${BASE}/api/v1/admin/act`, {
    headers: { ...ORIGIN, ...(await memberHeaders(api)) },
    data: { action, ids, args },
  })
  expect(res.ok()).toBe(true)
  expect(((await res.json()) as { failed: unknown[] }).failed).toEqual([])
}

/** The console's row for the app named `name`, among those `filter` lists. */
async function appRow(
  api: APIRequestContext,
  name: string,
  filter: 'approved' | 'draft' | 'suspended',
): Promise<{ id: string; clientId: string; status: string } | undefined> {
  const res = await api.get(`${BASE}/api/v1/admin/apps?f=${filter}`, {
    headers: await memberHeaders(api),
  })
  expect(res.ok()).toBe(true)
  const { rows } = (await res.json()) as {
    rows: { id: string; name: string; clientId: string; status: string }[]
  }
  return rows.find((r) => r.name === name)
}

/** The app's own HTTP client: no cookie, no address, nothing but what each call names. */
let http: APIRequestContext
let clientId = ''

test.beforeAll(async ({ browser }) => {
  http = await request.newContext({ storageState: { cookies: [], origins: [] } })
  const { context } = await member(browser, 1, { admin: true })
  const api = context.request
  await act(api, 'app.create', [], {
    app: {
      name: APP,
      developer: 'Fieldnotes Labs',
      contactEmail: 'dev@fieldnotes.example',
      homepageUrl: 'https://fieldnotes.example',
      privacyUrl: null,
      redirectUris: [REDIRECT],
      maxScope: 'write',
      allowEmail: false,
      owner: null,
      perMemberPerMin: null,
      perAppPerMin: null,
      maxConnections: null,
    },
  })
  const draft = await appRow(api, APP, 'draft')
  if (!draft) throw new Error('the registered app is not among the drafts')
  await act(api, 'app.approve', [draft.id])
  clientId = draft.clientId
  await context.close()
})

test.afterAll(async () => {
  await http.dispose()
})

/**
 * Approve the request on the consent page the member's browser shows, as the member, and
 * exchange the code the listener caught.
 */
async function connect(page: Page, app: FakeApp, level?: 'read') {
  await page.goto(app.url)
  await expect(page.getByTestId('connect-consent')).toBeVisible()
  if (level) await page.getByTestId(`connect-level-${level}`).check()
  await page.getByTestId('connect-approve').click()
  const answer = await app.answer()
  expect(answer).toMatchObject({ state: app.state, iss: GATEWAY, error: null })
  await expect(page.locator('#fake-app')).toBeVisible()
  return app.exchange(http, answer.code ?? '')
}

test('an app connects, syncs, reads a body, marks a post read, and Settings disconnects it', async ({
  browser,
}) => {
  const { context, page } = await member(browser, 2, {
    feeds: ['/formatting/zh.xml', '/formatting/en.xml'],
  })
  // Blogs of their own, never the fixture server's (whose reader count the public spec holds
  // below three), and new to Tela until the styles spec: fetched now, each a post with pictures.
  await cycle(context.request)
  const app = await fakeApp(clientId)
  try {
    await page.goto(app.url)
    const consent = page.getByTestId('connect-consent')
    await expect(consent.getByRole('heading', { level: 1 })).toHaveText(
      `Connect ${APP} to your Tela account?`,
    )
    await expect(consent).toContainText('By Fieldnotes Labs')
    await expect(page.getByTestId('connect-draft')).toHaveCount(0)
    await expect(page.getByTestId('connect-account')).toBeVisible()
    await expect(page.getByTestId('connect-level-write')).toBeChecked()
    await expect(page.getByTestId('connect-never').getByRole('listitem')).toHaveCount(4)
    await page.getByTestId('connect-approve').click()
    const answer = await app.answer()
    expect(answer).toMatchObject({ state: app.state, iss: GATEWAY, error: null })
    expect(answer.code).toBeTruthy()
    await expect(page.locator('#fake-app')).toBeVisible()

    const tokens = await app.exchange(http, answer.code ?? '')
    expect(tokens).toMatchObject({ token_type: 'Bearer', expires_in: 3600, scope: 'write' })
    expect(tokens.access_token).toMatch(/^tela_at_/)
    expect(tokens.refresh_token).toMatch(/^tela_rt_/)

    // Who: the member, at the level granted, and never the address or an admin flag.
    const me = await http.get(`${GATEWAY}/v1/me`, { headers: bearer(tokens) })
    expect(me.status()).toBe(200)
    const who = (await me.json()) as Record<string, unknown>
    expect(who.scope).toBe('write')
    expect(typeof who.handle).toBe('string')
    expect(who).not.toHaveProperty('email')
    expect(who).not.toHaveProperty('isAdmin')

    // A snapshot of what the member follows, in the cursor's language.
    const pulled = await http.get(`${GATEWAY}/v1/sync?lang=en`, { headers: bearer(tokens) })
    expect(pulled.status()).toBe(200)
    type Pull = {
      cursor: string
      reset: boolean
      rows: {
        feeds: { id: number; feedUrl: string }[]
        subscriptions: { feedId: number }[]
        articles: { id: number; feedId: number; contentKey: string | null }[]
        states: { articleId: number; readAt: number | null }[]
      }
    }
    const snapshot = (await pulled.json()) as Pull
    expect(snapshot.reset).toBe(true)
    expect(snapshot.rows.subscriptions).toHaveLength(2)
    const feedOf = (path: string) => snapshot.rows.feeds.find((f) => f.feedUrl.endsWith(path))?.id
    const postOf = (path: string) =>
      snapshot.rows.articles.find((a) => a.feedId === feedOf(path) && a.contentKey)
    const essay = postOf('/formatting/zh.xml')
    const pictures = postOf('/formatting/en.xml')
    if (!essay?.contentKey || !pictures?.contentKey) throw new Error('no bodies in the snapshot')

    // Bodies in one bundle, from R2 at the gateway, after tela-api allowed them: subscribed
    // blogs, so neither counts against the day.
    const bundle = await http.get(
      `${GATEWAY}/v1/bodies?keys=${essay.contentKey},${pictures.contentKey}`,
      { headers: bearer(tokens) },
    )
    expect(bundle.status()).toBe(200)
    const bodies = (await bundle.json()) as {
      objects: Record<string, { key: string; blocks: unknown[]; images: string[] }>
      refused: Record<string, unknown>
    }
    expect(bodies.refused).toEqual({})
    expect(bodies.objects[essay.contentKey]?.blocks.length).toBeGreaterThan(0)
    const picture = bodies.objects[pictures.contentKey]
    expect(picture?.images[0]).toBe(`${FIXTURES}/pixel.png`)

    // A picture asks for the token, and is decided like its post: allowed, the proxy fetches it,
    // and refuses the fixture's loopback address as it refuses any private one. Without the
    // token, nothing is decided at all.
    const image = `${GATEWAY}/img/${pictures.contentKey}/0`
    const anonymous = await http.get(image)
    expect(anonymous.status()).toBe(401)
    expect(await anonymous.json()).toEqual({ error: 'invalid_token' })
    const proxied = await http.get(image, { headers: bearer(tokens) })
    expect(proxied.status()).toBe(403)
    expect(await proxied.text()).toBe('forbidden')

    // A change pushed, and seen by the next pull and by the web.
    const read = await http.post(`${GATEWAY}/v1/mutations`, {
      headers: bearer(tokens),
      data: {
        mutations: [
          { mid: `e2e-${Date.now()}`, at: Date.now(), type: 'markRead', articleId: essay.id },
        ],
      },
    })
    expect(read.status()).toBe(200)
    expect(((await read.json()) as { results: { status: string }[] }).results).toMatchObject([
      { status: 'applied' },
    ])
    const delta = (await (
      await http.get(`${GATEWAY}/v1/sync?lang=en&cursor=${encodeURIComponent(snapshot.cursor)}`, {
        headers: bearer(tokens),
      })
    ).json()) as Pull
    expect(delta.reset).toBe(false)
    expect(delta.rows.states.find((s) => s.articleId === essay.id)?.readAt).toEqual(
      expect.any(Number),
    )
    expect((await readStateOnServer(context.request, essay.id)).readAt).toBe(true)

    // Settings lists it, with what it may do and on how many devices.
    await page.goto('/settings/apps')
    const row = page.getByTestId('connection').filter({ hasText: APP })
    await expect(row.getByTestId('connection-name')).toHaveText(APP)
    await expect(row.getByTestId('connection-level')).toHaveText('Read and write')
    await expect(row.getByTestId('connection-when')).toContainText('1 device')
    await row.getByTestId('connection-disconnect').click()
    await expect(row.getByTestId('connection-confirm')).toContainText(`Disconnect ${APP}?`)
    await row.getByTestId('connection-disconnect-yes').click()
    await expect(page.getByTestId('connections-none')).toBeVisible()

    // Ended on every device: the access token at once, the refresh token for good.
    const after = await http.get(`${GATEWAY}/v1/me`, { headers: bearer(tokens) })
    expect(after.status()).toBe(401)
    expect(await after.json()).toEqual({ error: 'invalid_token' })
    expect(await refresh(http, clientId, tokens.refresh_token)).toEqual({
      status: 400,
      error: 'invalid_grant',
    })
  } finally {
    await app.close()
    await context.close()
  }
})

test('declined, the app hears access_denied with its own state, and holds nothing', async ({
  browser,
}) => {
  const { context, page } = await member(browser, 3)
  const app = await fakeApp(clientId)
  try {
    await page.goto(app.url)
    await page.getByTestId('connect-decline').click()
    expect(await app.answer()).toEqual({
      code: null,
      state: app.state,
      iss: GATEWAY,
      error: 'access_denied',
    })
    // The listener hears the request before the browser has its page: let it land first.
    await expect(page.locator('#fake-app')).toBeVisible()
    await page.goto('/settings/apps')
    await expect(page.getByTestId('connections-none')).toBeVisible()
  } finally {
    await app.close()
    await context.close()
  }
})

test('lowered to Read only, the token reads and is refused a change', async ({ browser }) => {
  const { context, page } = await member(browser, 4)
  const app = await fakeApp(clientId)
  try {
    const tokens = await connect(page, app, 'read')
    expect(tokens.scope).toBe('read')
    const me = await http.get(`${GATEWAY}/v1/me`, { headers: bearer(tokens) })
    expect(((await me.json()) as { scope: string }).scope).toBe('read')
    const pulled = await http.get(`${GATEWAY}/v1/sync?lang=en`, { headers: bearer(tokens) })
    expect(pulled.status()).toBe(200)
    const push = await http.post(`${GATEWAY}/v1/mutations`, {
      headers: bearer(tokens),
      data: { mutations: [] },
    })
    expect(push.status()).toBe(403)
    expect(await push.json()).toEqual({ error: 'insufficient_scope' })
    await page.goto('/settings/apps')
    await expect(
      page.getByTestId('connection').filter({ hasText: APP }).getByTestId('connection-level'),
    ).toHaveText('Read only')
  } finally {
    await app.close()
    await context.close()
  }
})

test('a visitor signs in on the consent page and stays on it, the request intact', async ({
  browser,
}) => {
  const context = await browser.newContext({
    baseURL: BASE,
    storageState: { cookies: [], origins: [] },
    extraHTTPHeaders: { 'cf-connecting-ip': '100.64.1.5' },
  })
  const page = await context.newPage()
  const email = `connect-visitor-${Date.now()}@e2e.test`
  await inviteAndReadCode(context.request, email)
  const mails = async () =>
    (
      (await (
        await context.request.get(`${BASE}/api/test/outbox?email=${encodeURIComponent(email)}`)
      ).json()) as unknown[]
    ).length
  const app = await fakeApp(clientId)
  try {
    await page.goto(app.url)
    await expect(page.getByTestId('connect-sign-in')).toBeVisible()
    // The sheet opens by itself, over the page: nothing is asked before someone has signed in.
    const sheet = page.getByTestId('front-door')
    await expect(sheet).toBeVisible()
    await expect(page.getByTestId('connect-consent')).toHaveCount(0)
    const before = await mails()
    await sheet.getByTestId('login-mode').click()
    await sheet.getByTestId('login-email').fill(email)
    await sheet.getByTestId('login-submit').click()
    await expect(sheet.getByTestId('login-code')).toBeVisible()
    await expect.poll(mails).toBeGreaterThan(before)
    await sheet.getByTestId('login-code').fill(await latestCode(context.request, email))
    await sheet.getByTestId('login-submit').click()
    await expect(sheet).toHaveCount(0)

    // Still here, every parameter of the request as the app sent it, and asked now.
    await expect(page.getByTestId('connect-consent')).toBeVisible()
    const here = new URL(page.url())
    expect(here.pathname).toBe('/connect')
    for (const [name, value] of app.query) expect(here.searchParams.getAll(name)).toEqual([value])
    await expect(page.getByTestId('connect-account')).toBeVisible()
    await page.getByTestId('connect-approve').click()
    const answer = await app.answer()
    expect(answer).toMatchObject({ state: app.state, iss: GATEWAY, error: null })
    expect((await app.exchange(http, answer.code ?? '')).scope).toBe('write')
  } finally {
    await app.close()
    await context.close()
  }
})

test('the console registers an app, approves it, and cuts it off: its token is refused at once', async ({
  browser,
}) => {
  const admin = await member(browser, 6, { admin: true })
  const reader = await member(browser, 7)
  const name = `Ledgerline ${Date.now().toString(36)}`
  const page = admin.page
  try {
    await page.goto('/admin/apps')
    await page.locator('[data-testid="admin-create"][data-action="app.create"]').click()
    const form = page.locator('[data-testid="admin-input"][data-kind="app"]')
    await form.getByTestId('app-form-name').fill(name)
    await form.getByTestId('app-form-developer').fill('Ledgerline Ltd')
    await form.getByTestId('app-form-contactEmail').fill('dev@ledgerline.example')
    await form.getByTestId('app-form-redirectUris').fill(REDIRECT)
    await form.getByTestId('app-form-scope-write').check()
    await form.getByTestId('admin-input-submit').click()
    await expect(form).toHaveCount(0)

    // A draft until approved: only its owner could connect it, and it has none.
    await page.locator('[data-testid="admin-filter"][data-filter="draft"]').click()
    await page.getByTestId('admin-row').filter({ hasText: name }).click()
    const record = page.getByTestId('admin-record')
    await expect(record.getByTestId('admin-app-redirects')).toHaveText(REDIRECT)
    await record.locator('[data-testid="admin-record-action"][data-action="app.approve"]').click()
    await expect(page.getByTestId('admin-toast')).toBeVisible()
    await expect
      .poll(async () => (await appRow(page.request, name, 'approved'))?.status)
      .toBe('approved')
    const approved = await appRow(page.request, name, 'approved')
    if (!approved) throw new Error('the approved app is not listed')

    // A member connects it, and its token works.
    const app = await fakeApp(approved.clientId)
    let tokens: Tokens
    try {
      tokens = await connect(reader.page, app)
    } finally {
      await app.close()
    }
    expect((await http.get(`${GATEWAY}/v1/me`, { headers: bearer(tokens) })).status()).toBe(200)

    // Cut off, after a question: every call refused from the next one, the tokens kept.
    await page.locator('[data-testid="admin-filter"][data-filter="approved"]').click()
    await page.getByTestId('admin-row').filter({ hasText: name }).click()
    await record.locator('[data-testid="admin-record-action"][data-action="app.suspend"]').click()
    await page.getByTestId('admin-confirm-yes').click()
    await expect
      .poll(async () => (await appRow(page.request, name, 'suspended'))?.status)
      .toBe('suspended')
    const refused = await http.get(`${GATEWAY}/v1/me`, { headers: bearer(tokens) })
    expect(refused.status()).toBe(403)
    expect(await refused.json()).toEqual({ error: 'app_suspended' })
    expect(await refresh(http, approved.clientId, tokens.refresh_token)).toEqual({
      status: 400,
      error: 'unauthorized_client',
    })
  } finally {
    await admin.context.close()
    await reader.context.close()
  }
})

/**
 * The admin console (ADR 0039): only a member the operator granted it opens it, and to anyone else
 * (a visitor too) it is a page that does not exist; an admin hides a featured blog from Discover
 * and takes it back, lists a blog a member added from the review queue and takes that back too
 * (ADR 0041), works a ledger from the keyboard, pauses a feed, opens a claim no filter lists, and
 * reads it all in Chinese; and the console fits a phone. Each member here is new and comes from an
 * address of its own (sign-in is limited per address).
 */
import { type Browser, expect, type Page, test } from '@playwright/test'
import { FRESH } from './fresh'
import {
  ADMIN_TOKEN,
  addFeed,
  BASE,
  cycle,
  FIXTURES,
  fromAccountMenu,
  signInRequest,
} from './helpers'

test.use({ storageState: { cookies: [], origins: [] } })

const ORIGIN = { origin: BASE }

/** A new member on a page of their own, granted the console when `admin`. */
async function member(
  browser: Browser,
  n: number,
  options: { admin: boolean; locale?: string; width?: number },
): Promise<Page> {
  const context = await browser.newContext({
    baseURL: BASE,
    extraHTTPHeaders: { 'cf-connecting-ip': `192.0.2.${n}` },
    ...(options.width ? { viewport: { width: options.width, height: 860 } } : {}),
  })
  if (options.locale) {
    await context.addCookies([{ name: 'tela_locale', value: options.locale, url: BASE }])
  }
  const email = `admin-${n}-${Date.now()}@e2e.test`
  await signInRequest(context.request, email)
  if (options.admin) {
    const granted = await context.request.post(`${BASE}/api/admin/admins`, {
      headers: { ...ORIGIN, authorization: `Bearer ${ADMIN_TOKEN}` },
      data: { email, admin: true },
    })
    expect(granted.ok()).toBe(true)
  }
  return context.newPage()
}

/** A blog featured in Discover by the operator, as `bun run admin curate` does; its site id. */
async function curated(page: Page): Promise<number> {
  const res = await page.request.post(`${BASE}/api/admin/curate`, {
    headers: { ...ORIGIN, authorization: `Bearer ${ADMIN_TOKEN}` },
    data: { feedUrl: `${FIXTURES}/jvns.xml`, topics: ['tech'], featured: true },
  })
  expect(res.ok()).toBe(true)
  return ((await res.json()) as { siteId: number }).siteId
}

/** The console's own chunk (ADR 0039), which nobody but an admin should ever fetch. */
const ADMIN_CHUNK = /\/assets\/admin-[^/]*\.js(\?|$)/

/** Every script the page asks for from now on. */
function scriptsOf(page: Page): string[] {
  const urls: string[] = []
  page.on('request', (request) => {
    if (request.resourceType() === 'script') urls.push(request.url())
  })
  return urls
}

/** What a member call carries: the client's protocol and the member it names. */
async function asMember(page: Page): Promise<Record<string, string>> {
  const me = (await (await page.request.get(`${BASE}/api/v1/me`)).json()) as { id: string }
  return { 'x-tela-client': '2', 'x-tela-member': me.id }
}

/** The site's listing, as the console's own Discover ledger reads it. */
async function listingOf(page: Page, siteId: number): Promise<string | undefined> {
  const res = await page.request.get(`${BASE}/api/v1/admin/sites/${siteId}`, {
    headers: await asMember(page),
  })
  return ((await res.json()) as { site?: { listing: string } }).site?.listing
}

test('a visitor at /admin finds a page that does not exist, not a way to sign in', async ({
  page,
}) => {
  const scripts = scriptsOf(page)
  await page.goto('/admin')
  await expect(page.getByTestId('not-found')).toBeVisible()
  await expect(page).toHaveURL(/\/admin$/)
  await expect(page.getByTestId('admin-shell')).toHaveCount(0)
  await page.goto('/admin/claims?id=1')
  await expect(page.getByTestId('not-found')).toBeVisible()
  await expect(page).toHaveURL(/\/admin\/claims/)
  expect(scripts.filter((url) => ADMIN_CHUNK.test(url))).toEqual([])
})

test('a member the operator has not granted finds nothing at /admin, and no menu item', async ({
  browser,
}) => {
  const page = await member(browser, 11, { admin: false })
  await page.goto('/reading')
  await page.getByTestId('account-menu').click()
  await expect(page.getByTestId('nav-settings')).toBeVisible()
  await expect(page.getByTestId('nav-admin')).toHaveCount(0)
  const scripts = scriptsOf(page)
  await page.goto('/admin')
  await expect(page.getByTestId('not-found')).toBeVisible()
  await expect(page.getByTestId('admin-shell')).toHaveCount(0)
  // Not found before the console's chunk: it is never fetched for a member who is no admin.
  expect(scripts.filter((url) => ADMIN_CHUNK.test(url))).toEqual([])
})

test('an admin hides a featured blog from Discover, and takes it back with Undo', async ({
  browser,
}) => {
  const page = await member(browser, 12, { admin: true })
  const siteId = await curated(page)
  await page.goto('/reading')
  const scripts = scriptsOf(page)
  await fromAccountMenu(page, 'nav-admin')
  await expect(page).toHaveURL(/\/admin$/)
  await expect(page.getByTestId('admin-overview')).toBeVisible()
  // The pattern the two specs above rely on does match the chunk an admin loads.
  expect(scripts.some((url) => ADMIN_CHUNK.test(url))).toBe(true)
  await expect(page.getByTestId('admin-health')).toBeVisible()

  await page.locator('[data-testid="admin-nav-item"][data-area="discover"]').click()
  await expect(page).toHaveURL(/\/admin\/discover/)
  // Discover opens on its review queue (ADR 0041); a featured blog is under Featured.
  await page.locator('[data-testid="admin-filter"][data-filter="featured"]').click()
  await expect(page).toHaveURL(/f=featured/)
  const row = page.locator(`[data-testid="admin-row"][data-row-id="${siteId}"]`)
  await row.click()
  await expect(page.getByTestId('admin-record')).toBeVisible()
  await page
    .getByTestId('admin-record')
    .locator('[data-testid="admin-record-action"][data-action="site.hide"]')
    .click()
  await expect(page.getByTestId('admin-toast')).toContainText('Hidden')
  await expect(row).toHaveCount(0)
  expect(await listingOf(page, siteId)).toBe('rejected')

  await page.getByTestId('admin-undo').click()
  await expect(page.getByTestId('admin-toast')).toContainText('Undone')
  await expect(row).toBeVisible()
  expect(await listingOf(page, siteId)).toBe('featured')
})

test('a blog a member added waits under To review; List lists it, and Undo puts it back', async ({
  browser,
}) => {
  const page = await member(browser, 17, { admin: true })
  // A blog of its own (`./fresh.ts`), added as any member adds one: private, one reader, posts.
  await addFeed(page.request, `${FIXTURES}/fresh/es.xml`)
  await cycle(page.request)
  await page.goto('/admin')
  const nav = page.locator('[data-testid="admin-nav-item"][data-area="discover"]')
  await expect(nav.getByTestId('admin-badge')).toBeVisible()
  await nav.click()
  await expect(page).toHaveURL(/\/admin\/discover$/)
  await expect(
    page.locator('[data-testid="admin-filter"][data-filter="candidates"]'),
  ).toHaveAttribute('aria-pressed', 'true')
  const row = page.getByTestId('admin-row').filter({ hasText: FRESH.es.blog })
  await expect(row).toContainText('To review')
  await row.click()
  const record = page.getByTestId('admin-record')
  // How many read it, never who: the record names no member.
  await expect(record).toContainText('A member added this blog.')
  await expect(record).not.toContainText('@')
  await record.locator('[data-testid="admin-record-action"][data-action="site.list"]').click()
  // It has no topics yet, so Discover would file it only under All: the toast says so.
  await expect(page.getByTestId('admin-toast')).toContainText('Listed, with no topics yet')
  await expect(row).toHaveCount(0)
  await page.locator('[data-testid="admin-filter"][data-filter="listed"]').click()
  await expect(page.getByTestId('admin-row').filter({ hasText: FRESH.es.blog })).toBeVisible()

  await page.getByTestId('admin-undo').click()
  await expect(page.getByTestId('admin-toast')).toContainText('Undone')
  await page.locator('[data-testid="admin-filter"][data-filter="candidates"]').click()
  await expect(page.getByTestId('admin-row').filter({ hasText: FRESH.es.blog })).toBeVisible()
})

test('the keyboard moves, checks, opens and closes; Escape clears the checks', async ({
  browser,
}) => {
  const page = await member(browser, 13, { admin: true })
  await curated(page)
  await page.goto('/admin/sites?f=discover')
  const rows = page.getByTestId('admin-row')
  await expect(rows.first()).toBeVisible()
  await page.keyboard.press('j')
  await expect(rows.first()).toHaveAttribute('data-focus', 'true')
  await page.keyboard.press('x')
  await expect(page.getByTestId('admin-bulk')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('admin-bulk')).toHaveCount(0)
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('admin-record')).toBeVisible()
  await expect(page).toHaveURL(/[?&]id=/)
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('admin-record')).toHaveCount(0)
  await page.keyboard.press('/')
  await expect(page.getByTestId('admin-search')).toBeFocused()
})

test('an admin pauses a feed that fetches as it should, and it waits under Paused', async ({
  browser,
}) => {
  const page = await member(browser, 14, { admin: true })
  await curated(page)
  await page.goto('/admin/feeds?f=fetching&q=jvns')
  const row = page.getByTestId('admin-row').first()
  await expect(row).toBeVisible()
  const feedId = await row.getAttribute('data-row-id')
  await row.click()
  await page
    .getByTestId('admin-record')
    .locator('[data-testid="admin-record-action"][data-action="feed.pause"]')
    .click()
  await expect(page.getByTestId('admin-toast')).toContainText('Paused')
  await page.goto('/admin/feeds?f=paused')
  await expect(page.locator(`[data-testid="admin-row"][data-row-id="${feedId}"]`)).toBeVisible()
  // Back as it was, for the specs that read this feed after.
  await page.locator(`[data-testid="admin-row"][data-row-id="${feedId}"]`).click()
  await page
    .getByTestId('admin-record')
    .locator('[data-testid="admin-record-action"][data-action="feed.resume"]')
    .click()
  await expect(page.getByTestId('admin-toast')).toContainText('Resumed')
})

test('a claim the operator rejected, under no filter, still opens by its id', async ({
  browser,
}) => {
  const page = await member(browser, 16, { admin: true })
  await curated(page)
  const headers = await asMember(page)
  // The admin claims the curated blog as a member would, and rejects the claim at once: failed
  // and reviewed, it is in none of Claims' filters (not in review, not checking, not verified).
  const started = await page.request.post(`${BASE}/api/v1/claims`, {
    headers: { ...headers, ...ORIGIN },
    data: { url: `${FIXTURES}/jvns.xml` },
  })
  expect(started.ok()).toBe(true)
  const { siteId } = (await started.json()) as { siteId: number }
  const verify = await page.request.post(`${BASE}/api/v1/claims/${siteId}/verify`, {
    headers: { ...headers, ...ORIGIN },
  })
  expect(verify.ok()).toBe(true)
  const site = (await (
    await page.request.get(`${BASE}/api/v1/admin/sites/${siteId}`, { headers })
  ).json()) as { claims: { id: string; claimant: { id: string } | null }[] }
  const claim = site.claims.find((c) => c.claimant?.id === headers['x-tela-member'])
  expect(claim).toBeTruthy()
  const claimId = claim!.id
  const rejected = await page.request.post(`${BASE}/api/v1/admin/act`, {
    headers: { ...headers, ...ORIGIN },
    data: { action: 'claim.reject', ids: [claimId], args: { reason: 'Not the author' } },
  })
  expect(((await rejected.json()) as { done: string[] }).done).toEqual([claimId])

  await page.goto(`/admin/claims?id=${claimId}`)
  const record = page.getByTestId('admin-record')
  await expect(record).toBeVisible()
  await expect(record).toContainText('Not the author')
  await expect(record).not.toContainText('It no longer exists')
})

test('the console speaks Simplified Chinese to a member who reads it', async ({ browser }) => {
  const page = await member(browser, 15, { admin: true, locale: 'zh-Hans' })
  await page.goto('/admin')
  await expect(page.locator('[data-testid="admin-nav-item"][data-area="claims"]')).toContainText(
    '认领',
  )
  await expect(page.getByTestId('admin-overview')).toContainText('概览')
})

for (const [i, width] of [412, 768, 1024, 1280].entries()) {
  test(`the console fits ${width} px without scrolling sideways`, async ({ browser }) => {
    const page = await member(browser, 20 + i, { admin: true, width })
    await curated(page)
    for (const path of ['/admin', '/admin/discover?f=featured']) {
      await page.goto(path)
      await expect(page.getByTestId('admin-shell')).toBeVisible()
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      )
      expect({ path, overflow }).toEqual({ path, overflow: 0 })
    }
    await page.getByTestId('admin-row').first().click()
    await expect(page.getByTestId('admin-record')).toBeVisible()
    await expect(
      page.getByTestId('admin-record').getByTestId('admin-record-action').first(),
    ).toBeInViewport()
  })
}

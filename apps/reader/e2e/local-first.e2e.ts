/**
 * The point of the local-first reader (ADR 0025): once the device has synced, reading is a
 * function of the local store and the URL. Opening articles, changing filters and going back
 * cost no request to tela-api or the object store.
 */
import { expect, test } from '@playwright/test'
import { heldOnDevice, synced } from './helpers'

test('after sync, five opens, a filter change and Back make no request to /api or /o', async ({
  page,
}) => {
  await page.goto('/reading')
  await synced(page)
  // An English feed while the reading language is EN: nothing here asks for a translation, so
  // any request is one a render waited on.
  await page.getByTestId('subscription').filter({ hasText: 'Julia Evans' }).click()
  await expect(page.getByTestId('article-row').first()).toContainText('Julia Evans')
  // Unread ones: prefetch fetches the bodies of what is unread, and specs before this read some.
  const unread = page.getByTestId('article-row').filter({ has: page.getByTestId('unread-dot') })
  await expect(unread.nth(4)).toBeVisible()
  const hrefs = await Promise.all([0, 1, 2, 3, 4].map((i) => unread.nth(i).getAttribute('href')))
  const ids = hrefs.map((href) => Number(/article=(\d+)/.exec(href ?? '')?.[1]))
  // The idle prefetch of bodies is what makes the opens free: wait until the device holds all
  // five, not for time to pass, which a slow runner can outlast.
  await expect.poll(() => heldOnDevice(page, ids), { timeout: 30_000 }).toEqual(ids)

  const requests: string[] = []
  page.on('request', (r) => {
    const path = new URL(r.url()).pathname
    // Pushes of the reads themselves, and the pulls after them, are the store writing behind:
    // never something a render waits on. Nor is the idle prefetch, which plans again after every
    // open (it marks a post read) and may fetch another post's translation meanwhile; its
    // requests say so.
    if (path === '/api/v1/mutations' || path === '/api/v1/sync') return
    if (r.headers()['x-tela-prefetch']) return
    if (path.startsWith('/api/') || path.startsWith('/o/')) requests.push(`${r.method()} ${path}`)
  })

  for (const href of hrefs) {
    await page.locator(`[data-testid="article-row"][href="${href}"]`).click()
    await expect(page.getByTestId('reader')).toBeVisible()
    await expect(page.locator('.article-body').first()).toBeVisible()
  }
  await page.locator('aside').getByRole('link', { name: /Today/ }).click()
  await expect(page).toHaveURL(/filter=today/)
  await page.goBack()
  await expect(page).toHaveURL(/article=\d+/)
  await expect(page.getByTestId('reader')).toBeVisible()
  await page.waitForTimeout(1000)
  expect(requests).toEqual([])
})

test('a reload renders the list from the device before any sync answers', async ({ page }) => {
  await page.goto('/reading')
  await synced(page)
  const subscriptions = await page.getByTestId('subscription').count()
  // Hold every sync call: what shows now can only come from IndexedDB.
  await page.route('**/api/v1/sync**', () => new Promise(() => {}))
  await page.route('**/api/v1/me', () => new Promise(() => {}))
  await page.reload()
  await expect(page.getByTestId('article-row').first()).toBeVisible()
  await expect(page.getByTestId('subscription')).toHaveCount(subscriptions)
})

test('a prefetch that failed is asked for again once the network is back', async ({ page }) => {
  // Bundles fail until the network "comes back". (Routing turns the HTTP cache off, which
  // nothing here needs.)
  let down = true
  const asked: string[] = []
  await page.route('**/o/bundle**', (route) => {
    asked.push(route.request().url())
    return down ? route.abort('internetdisconnected') : route.continue()
  })
  await page.goto('/reading')
  await synced(page)
  const unread = page.getByTestId('article-row').filter({ has: page.getByTestId('unread-dot') })
  await expect(unread.first()).toBeVisible()
  const ids = [Number(/article=(\d+)/.exec((await unread.first().getAttribute('href')) ?? '')?.[1])]
  await expect.poll(() => asked.length, { timeout: 30_000 }).toBeGreaterThan(0)
  // Any run for a plan still changing fails too; then the plan stays as it is.
  await page.waitForTimeout(2000)
  down = false
  // Back online the engine pulls, nothing new arrives, and the plan is unchanged: only the run
  // that fell short asking again fills the device.
  await page.evaluate(() => window.dispatchEvent(new Event('online')))
  await expect.poll(() => heldOnDevice(page, ids), { timeout: 30_000 }).toEqual(ids)
})

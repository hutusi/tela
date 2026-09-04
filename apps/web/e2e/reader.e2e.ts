import { createHmac } from 'node:crypto'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'

const FIXTURES = process.env.E2E_FIXTURE_URL ?? 'http://127.0.0.1:4790'
const IMAGE_SECRET = process.env.IMAGE_PROXY_SECRET ?? 'e2e-image-secret'

function signedImageUrl(url: string, secret = IMAGE_SECRET): string {
  const u = Buffer.from(url, 'utf8').toString('base64url')
  const s = createHmac('sha256', secret).update(u).digest('hex').slice(0, 32)
  return `/img?u=${u}&s=${s}`
}

test.describe('reader', () => {
  test('signed-in home redirects to reading with seeded subscriptions', async ({ page }) => {
    await page.goto('/')
    await expect(page).toHaveURL(/\/reading$/)
    const subs = page.getByTestId('subscription')
    await expect(subs).toHaveCount(2)
    await expect(subs.first()).toContainText(/Julia Evans|胡涂说/)
    await expect(page.getByTestId('article-row').first()).toBeVisible()
  })

  test('opening an article marks it read and like toggles the counter', async ({ page }) => {
    await page.goto('/reading')
    const row = page.getByTestId('article-row').first()
    const title = (await row.locator('h2').textContent())?.trim() ?? ''
    expect(row.getByTestId('unread-dot')).toBeVisible()
    await row.click()
    await expect(page).toHaveURL(/article=\d+/)
    await expect(page.getByTestId('article-title')).toHaveText(title)
    await expect(page.locator('.article-body')).toBeVisible()

    // Marked read on open: the row loses its dot after the refresh.
    await expect(page.getByTestId('article-row').first().getByTestId('unread-dot')).toHaveCount(0)

    const like = page.getByTestId('like-button')
    await expect(like).toContainText('0')
    await like.click()
    await expect(like).toContainText('1')
    await expect(like).toHaveAttribute('aria-pressed', 'true')
    await page.reload()
    await expect(page.getByTestId('like-button')).toContainText('1')
    await page.getByTestId('like-button').click()
    await expect(page.getByTestId('like-button')).toContainText('0')

    await page.getByTestId('close-article').click()
    await expect(page).not.toHaveURL(/article=/)
  })

  test('mark all read clears the counts for one feed', async ({ page }) => {
    await page.goto('/reading')
    const first = page.getByTestId('subscription').first()
    await first.click()
    await expect(page).toHaveURL(/feed=\d+/)
    await page.getByTestId('mark-all-read').click()
    await expect(page.getByTestId('unread-dot')).toHaveCount(0)
    await expect(page.getByTestId('subscription').first().locator('span').last()).toHaveText('')
  })

  test('the UI switches to Chinese', async ({ page }) => {
    await page.goto('/reading')
    await page.getByRole('button', { name: '中文' }).click()
    await expect(page.getByRole('link', { name: '阅读' })).toBeVisible()
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-Hans')
    await page.getByRole('button', { name: 'EN' }).click()
    await expect(page.getByRole('link', { name: 'Reading' })).toBeVisible()
  })

  test('add a feed by page URL, then the worker fills it', async ({ page }) => {
    await page.goto('/add')
    await page.getByTestId('feed-url').fill(`${FIXTURES}/blog`)
    await page.getByTestId('find-feeds').click()
    const candidates = page.getByTestId('feed-candidates')
    await expect(candidates).toContainText('jnito')
    await candidates.getByTestId('subscribe').first().click()
    await expect(page).toHaveURL(/\/reading\?feed=\d+/)
    await expect(page.getByTestId('subscription')).toHaveCount(3)
    // The worker picks the queued fetch up within seconds.
    await expect(page.getByTestId('article-row').first()).toBeVisible({ timeout: 45_000 })
  })

  test('OPML import subscribes to new feeds and skips bad entries', async ({ page }) => {
    await page.goto('/add')
    await page.getByTestId('opml-file').setInputFiles(join(__dirname, 'fixtures', 'subs.opml'))
    await page.getByTestId('opml-import').click()
    await expect(page.getByTestId('opml-result')).toContainText(/Imported \d+ feed/)
  })

  test('the image proxy serves signed URLs and rejects tampering', async ({ request }) => {
    const good = await request.get(signedImageUrl(`${FIXTURES}/pixel.png`))
    expect(good.status()).toBe(200)
    expect(good.headers()['content-type']).toBe('image/png')
    const bad = await request.get(signedImageUrl(`${FIXTURES}/pixel.png`, 'wrong'))
    expect(bad.status()).toBe(403)
    const html = await request.get(signedImageUrl(`${FIXTURES}/blog`))
    expect(html.status()).toBe(415)
  })
})

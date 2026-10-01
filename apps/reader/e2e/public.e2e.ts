/**
 * The public side and what a blogger does with it: Discover, a blog's page, claiming it, topics,
 * recommendations on a profile, the author's dashboard, settings, and search. Public pages are
 * rendered at the edge, so a visitor without JavaScript sees them too.
 */
import { readFile } from 'node:fs/promises'
import { expect, test } from '@playwright/test'
import { BASE, FIXTURES, fromAccountMenu, keepCycling, memberHeaders, synced } from './helpers'

test.describe('for a visitor', () => {
  test.use({ storageState: { cookies: [], origins: [] }, javaScriptEnabled: false })

  test('Discover and a blog page are whole pages without JavaScript, and never indexed', async ({
    page,
    request,
  }) => {
    const res = await page.goto('/discover')
    expect(res?.headers()['x-robots-tag']).toBe('noindex, nofollow')
    await expect(page.locator('meta[name="robots"]')).toHaveCount(0)
    await expect(page).toHaveTitle('Discover · Tela')
    await expect(page.getByTestId('topic-chips')).toBeVisible()
    await expect(page.getByRole('link', { name: 'Sign in' })).toBeVisible()

    const robots = await request.get('/robots.txt')
    expect(await robots.text()).toBe('User-agent: *\nDisallow: /\n')
    // The app's own pages are static assets, served without the Worker: the shell says it itself.
    await page.goto('/login')
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute(
      'content',
      'noindex, nofollow',
    )
    const missing = await page.goto('/s/999999')
    expect(missing?.status()).toBe(404)
    await expect(page.getByTestId('not-found')).toBeVisible()
  })
})

test.describe('discover and claim', () => {
  test('claiming a site by meta tag lists it in Discover with the badge', async ({
    page,
    request,
  }) => {
    await page.goto('/claim')
    await page.getByTestId('claim-url').fill(`${FIXTURES}/`)
    await page.getByTestId('claim-continue').click()
    await expect(page).toHaveURL(/\/sites\/\d+\/claim$/)
    const siteId = page.url().match(/\/sites\/(\d+)\/claim/)?.[1] as string
    const snippet = (await page.getByTestId('meta-snippet').textContent()) ?? ''
    const token = snippet.match(/content="([0-9a-f]+)"/)?.[1]
    expect(token).toBeTruthy()

    const stop = keepCycling(page)
    try {
      // Verify before the tag exists: a clear failure.
      await page.getByTestId('claim-verify').click()
      await expect(page.getByTestId('claim-page')).toHaveAttribute('data-status', 'failed', {
        timeout: 30_000,
      })
      await expect(page.getByTestId('claim-error')).toContainText('tela-site-verification')

      // Publish the token on the fixture home page and verify again.
      const set = await request.post(`${FIXTURES}/__claim-token?token=${token}`)
      expect(set.status()).toBe(204)
      await page.getByTestId('claim-verify').click()
      await expect(page.getByTestId('claim-verified')).toBeVisible({ timeout: 30_000 })
    } finally {
      stop()
    }

    await page.getByRole('link', { name: 'Discover' }).first().click()
    const card = page.locator(`[data-testid="site-card"][data-site-id="${siteId}"]`)
    await expect(card).toBeVisible()
    await expect(card.getByTestId('claimed-badge')).toBeVisible()
    await expect(card).toContainText(/reader/)
    await expect(page.getByTestId('topic-chips')).toContainText('Tech')
  })

  test('the site page lets the owner set topics, and Discover filters by them', async ({
    page,
  }) => {
    await page.goto('/discover')
    await page.getByTestId('site-card').first().locator('a[href^="/s/"]').first().click()
    await expect(page).toHaveURL(/\/s\/\d+$/)
    await expect(page.getByTestId('site-articles')).toBeVisible()
    const form = page.getByTestId('topics-form')
    await form.getByLabel('Tech').check()
    await form.getByRole('button', { name: 'Save' }).click()
    await expect(page.locator('a[href="/discover?topic=tech"]')).toBeVisible()

    await page.getByRole('link', { name: 'Discover' }).first().click()
    await page.getByTestId('topic-chips').getByRole('link', { name: 'Tech' }).click()
    await expect(page).toHaveURL(/topic=tech/)
    await expect(page.getByTestId('site-card')).toHaveCount(1)
    await page.getByTestId('topic-chips').getByRole('link', { name: 'Food' }).click()
    await expect(page.getByTestId('site-card')).toHaveCount(0)

    // Subscribing from the card is a mutation: it shows at once.
    await page.getByTestId('topic-chips').getByRole('link', { name: 'All' }).click()
    const button = page.getByTestId('site-card').first().getByTestId('site-subscribe')
    const wasSubscribed = (await button.getAttribute('aria-pressed')) === 'true'
    await button.click()
    await expect(button).toHaveAttribute('aria-pressed', wasSubscribed ? 'false' : 'true')
    await button.click()
    await expect(button).toHaveAttribute('aria-pressed', wasSubscribed ? 'true' : 'false')
  })

  test('a post on a blog page opens in the reader', async ({ page }) => {
    await page.goto('/discover')
    await page.getByTestId('site-card').first().locator('a[href^="/s/"]').first().click()
    const post = page.getByTestId('site-articles').getByRole('link').first()
    const title = (await post.textContent())?.trim() ?? ''
    await post.click()
    await expect(page).toHaveURL(/\/reading\?.*article=\d+/)
    await expect(page.getByTestId('article-title')).toHaveText(title)
  })
})

test.describe('recommendations, profile, dashboard, settings', () => {
  test('recommend with a note, see it on the profile and in the author dashboard', async ({
    page,
  }) => {
    await page.goto('/reading')
    await synced(page)
    await page.getByTestId('subscription').filter({ hasText: 'Julia Evans' }).click()
    await page.getByTestId('article-row').first().click()
    const title = (await page.getByTestId('article-title').textContent())?.trim() ?? ''
    await page.getByTestId('recommend-button').click()
    await page.getByTestId('recommend-note').fill('Worth your time, especially the ending.')
    await page.getByTestId('recommend-submit').click()
    await expect(page.getByTestId('toast')).toContainText('Recommended with your note')
    await expect(page.getByTestId('recommend-button')).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByTestId('recommend-button')).toContainText('1')
    // The profile is public data from the server: let the push land first.
    await page.waitForResponse((r) => r.url().includes('/api/v1/mutations') && r.ok())

    await fromAccountMenu(page, 'nav-profile')
    await expect(page).toHaveURL(/\/@[a-z0-9_]+$/)
    const recs = page.getByTestId('profile-recommendations')
    await expect(recs).toContainText(title.slice(0, 20))
    await expect(recs).toContainText('Worth your time')

    // The member claimed the fixture site earlier, so the note reaches the dashboard.
    await fromAccountMenu(page, 'nav-dashboard')
    await expect(page.getByTestId('dashboard-site')).toHaveCount(1)
    await expect(page.getByTestId('dashboard-notes')).toContainText('Worth your time')
    await expect(page.getByTestId('dashboard-post').first()).toBeVisible()
    await page.getByTestId('translation-optout').click()
    await expect(page.getByTestId('translation-optout')).toContainText('Allow translation')
    await page.getByTestId('translation-optout').click()
    await expect(page.getByTestId('translation-optout')).toContainText('Opt out of translation')
  })

  test('settings validate the handle and the profile link follows it', async ({ page }) => {
    await page.goto('/settings')
    await page.getByTestId('settings-handle').fill('settings')
    await page.getByTestId('settings-save').click()
    await expect(page.getByTestId('settings-error')).toContainText('reserved')
    await page.getByTestId('settings-handle').fill('devreader')
    await page.getByTestId('settings-display-name').fill('Dev Reader')
    await page.getByTestId('settings-save').click()
    await expect(page.getByTestId('settings-saved')).toBeVisible()
    await expect(page.getByTestId('profile-link')).toHaveAttribute('href', '/@devreader')
    await page.getByTestId('profile-link').click()
    await expect(page.getByTestId('profile-page')).toContainText('Dev Reader')

    // An edit made from the profile reaches it: the copy held while Settings was open, and the
    // one the browser cached (a minute, PUBLIC_CACHE), are forgotten once the server has the
    // change. A fresh load first: the rename above has already sent this page past the cache.
    await page.goto('/@devreader')
    await expect(page.getByTestId('profile-page')).toContainText('Dev Reader')
    await page.getByTestId('edit-profile').click()
    const bio = `Edited ${Date.now()}`
    await page.locator('textarea[name="bio"]').fill(bio)
    // Back only once the device has the change, so the profile page is not there to see it land.
    const pulled = page.waitForResponse(
      async (r) => r.url().includes('/api/v1/sync') && r.ok() && (await r.text()).includes(bio),
    )
    await page.getByTestId('settings-save').click()
    await expect(page.getByTestId('settings-saved')).toBeVisible()
    await pulled
    await page.goBack()
    await expect(page).toHaveURL(/\/@devreader$/)
    await expect(page.getByTestId('profile-page')).toContainText(bio)
  })

  test('OPML export lists the subscriptions', async ({ request }) => {
    // A member call like any other: it names the account, as the Settings button's fetch does.
    const res = await request.get(`${BASE}/api/v1/feeds/opml`, {
      headers: await memberHeaders(request),
    })
    expect(res.status()).toBe(200)
    expect(res.headers()['content-type']).toContain('opml')
    const body = await res.text()
    expect(body).toContain('<opml version="2.0">')
    expect(body).toContain(`xmlUrl="${FIXTURES}/jvns.xml"`)
  })

  test('the Settings button saves that list as a file', async ({ page }) => {
    // A fetch and a Blob, not a plain link: only a call can name the account (ADR 0025).
    await page.goto('/settings/subscriptions')
    const saved = page.waitForEvent('download')
    await page.getByTestId('opml-export').click()
    const download = await saved
    expect(download.suggestedFilename()).toBe('tela-subscriptions.opml')
    const body = await readFile(await download.path(), 'utf8')
    expect(body).toContain('<opml version="2.0">')
    expect(body).toContain(`xmlUrl="${FIXTURES}/jvns.xml"`)
  })
})

test.describe('search', () => {
  test('finds blogs by name and posts in subscriptions by title', async ({ page }) => {
    await page.goto('/reading')
    await synced(page)
    await page.getByTestId('subscription').filter({ hasText: 'Julia Evans' }).click()
    const firstTitle =
      (await page.getByTestId('article-row').first().locator('h2').textContent())?.trim() ?? ''
    const word = firstTitle.split(/\s+/).find((w) => w.length >= 4) ?? firstTitle.slice(0, 4)

    const input = page.getByTestId('search-input')
    await input.fill('Julia')
    await input.press('Enter')
    await expect(page).toHaveURL(/\/search\?q=Julia$/)
    // Every fixture feed belongs to the one fixture site, so "Julia" matches through a feed title.
    await expect(page.getByTestId('site-card').first()).toBeVisible()
    await expect(page.getByTestId('search-input')).toHaveValue('Julia')

    await page.getByTestId('search-input').fill(word)
    await page.getByTestId('search-input').press('Enter')
    const hit = page.getByTestId('article-hit').first()
    await expect(hit).toContainText(word)
    await hit.click()
    await expect(page).toHaveURL(/\/reading\?feed=\d+&article=\d+/)
    await expect(page.getByTestId('reader')).toBeVisible()

    await page.goto('/search?q=zzzz-nothing-here')
    await expect(page.getByTestId('search-empty')).toBeVisible()
  })
})

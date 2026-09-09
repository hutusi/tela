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
    // Dev auth has no sign-in callback. The first profile fallback repairs the missing cache so
    // later navigations do not keep putting that query in front of the reader's database wave.
    await expect
      .poll(async () => {
        const cookies = await page.context().cookies()
        return cookies.find((cookie) => cookie.name === 'tela_reading_lang')?.value
      })
      .toMatch(/:en$/)
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

    // Marked read on open: the navigation render already shows the selected row as read, so
    // the dot is gone without a second round trip.
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

  test('opening an article does not render the page at all', async ({ page }) => {
    await page.goto('/reading')
    // An English feed while the reading language is EN: nothing here asks for a translation, so
    // any request beyond the article's own is one the page asked for itself.
    await page.getByTestId('subscription').filter({ hasText: 'Julia Evans' }).click()
    await expect(page).toHaveURL(/\/reading\?feed=\d+/)
    await expect(page.getByTestId('article-row').first()).toBeVisible()

    const documents: string[] = []
    const paneFetches: string[] = []
    page.on('request', (r) => {
      const path = new URL(r.url()).pathname
      if (path === '/reading') documents.push(r.method())
      if (path === '/api/reading/article') paneFetches.push(r.method())
    })

    await page.getByTestId('article-row').first().click()
    await expect(page.getByTestId('article-title')).toBeVisible()
    await expect(page.locator('.article-body')).toBeVisible()
    await expect(page).toHaveURL(/article=\d+/)
    // Long enough for a stray refresh to arrive.
    await page.waitForTimeout(1500)

    // The pane comes from a route handler. Rendering this page on the server costs about 67 ms of
    // CPU against a 10 ms Workers Free budget, which is what produced Error 1102 (ADR 0017); the
    // route handler costs about 20 ms. mark-read still posts to /reading, hence GETs only.
    expect(paneFetches).toHaveLength(1)
    expect(documents.filter((m) => m === 'GET')).toHaveLength(0)
  })

  test('going back to a client-opened article brings the article back', async ({ page }) => {
    await page.goto('/reading')
    await page.getByTestId('article-row').first().click()
    await expect(page.getByTestId('reader')).toBeVisible()
    const opened = page.url()
    expect(opened).toMatch(/article=\d+/)

    // A real navigation away. The history entry we came from was written by pushState, so Next
    // has no server payload for it and replays the one from before the article was opened.
    await page.locator('aside').getByRole('link', { name: /Today/ }).click()
    await expect(page).toHaveURL(/\/reading\?filter=today$/)
    await expect(page.getByTestId('reader')).toHaveCount(0)

    // Back must restore the article, not just its URL. Trusting that stale server state over the
    // URL left the address bar saying article=… with an empty third column.
    await page.goBack()
    await expect(page).toHaveURL(opened)
    await expect(page.getByTestId('reader')).toBeVisible()
    await expect(page.getByTestId('article-title')).toBeVisible()

    // And forward again closes it, for the same reason in the other direction.
    await page.goForward()
    await expect(page).toHaveURL(/\/reading\?filter=today$/)
    await expect(page.getByTestId('reader')).toHaveCount(0)
  })

  test('a new article opens at its top, not where the last one was left', async ({ page }) => {
    await page.goto('/reading')
    const rows = page.getByTestId('article-row')
    await rows.first().click()
    await expect(page.getByTestId('reader')).toBeVisible()

    // Read a way down the first article. A navigation used to reset this for free; pushState
    // does not, so the next article used to open with its title above the fold.
    await page.evaluate(() => window.scrollTo(0, 700))
    expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0)

    await rows.nth(1).click()
    await expect(page.getByTestId('reader')).toBeVisible()
    await expect.poll(async () => page.evaluate(() => window.scrollY), { timeout: 5000 }).toBe(0)
    await expect(page.getByTestId('article-title')).toBeInViewport()
  })

  test('a row read during this visit stays dimmed after the article closes', async ({ page }) => {
    await page.goto('/reading')
    await page.getByTestId('subscription').filter({ hasText: 'Julia Evans' }).click()
    await expect(page).toHaveURL(/\/reading\?feed=\d+/)
    const row = page.getByTestId('article-row').first()
    const opacity = () => row.evaluate((el) => getComputedStyle(el).opacity)

    if ((await row.getAttribute('data-read')) === '0') expect(Number(await opacity())).toBe(1)
    await row.click()
    await expect(page.getByTestId('reader')).toBeVisible()
    await page.getByTestId('close-article').click()
    await expect(page.getByTestId('reader')).toHaveCount(0)

    // Opening it marked it read. The dimming has to follow the state the row is actually in, not
    // the one the server rendered it in.
    await expect(row).toHaveAttribute('data-read', '1')
    expect(Number(await opacity())).toBeLessThan(1)
  })

  test('filter and subscription navigations close a client-opened article', async ({ page }) => {
    await page.goto('/reading')
    await page.getByTestId('article-row').first().click()
    await expect(page.getByTestId('reader')).toBeVisible()

    await page.locator('aside').getByRole('link', { name: /Today/ }).click()
    await expect(page).toHaveURL(/\/reading\?filter=today$/)
    await expect(page.getByTestId('reader')).toHaveCount(0)
    await expect(page.getByTestId('reading-layout')).not.toHaveAttribute('data-open')

    await page.locator('aside a[href="/reading"]').click()
    await expect(page).toHaveURL(/\/reading$/)
    await page.getByTestId('article-row').first().click()
    await expect(page.getByTestId('reader')).toBeVisible()
    await page.getByTestId('subscription').first().click()
    await expect(page).toHaveURL(/\/reading\?feed=\d+$/)
    await expect(page.getByTestId('reader')).toHaveCount(0)
    await expect(page.getByTestId('reading-layout')).not.toHaveAttribute('data-open')
  })

  test('a direct link to a missing article says it is gone', async ({ page }) => {
    await page.goto('/reading?article=999999999')
    await expect(page.getByTestId('article-gone')).toBeVisible()
    await expect(page.getByTestId('reading-layout')).toHaveAttribute('data-open', '1')

    await page.getByRole('button', { name: 'Close' }).click()
    await expect(page).toHaveURL(/\/reading$/)
    await expect(page.getByTestId('article-gone')).toHaveCount(0)
    await expect(page.getByTestId('article-list')).toBeVisible()
  })

  test('unliking in the Liked view takes the article out of the list', async ({ page }) => {
    await page.goto('/reading')
    await page.getByTestId('subscription').filter({ hasText: 'Julia Evans' }).click()
    await expect(page).toHaveURL(/\/reading\?feed=\d+/)
    await page.getByTestId('article-row').first().click()
    await expect(page).toHaveURL(/article=\d+/)
    const articleId = new URL(page.url()).searchParams.get('article')
    const likeButton = page.getByTestId('like-button')
    if ((await likeButton.getAttribute('aria-pressed')) !== 'true') await likeButton.click()
    await expect(likeButton).toHaveAttribute('aria-pressed', 'true')

    await page.goto('/reading?filter=liked')
    const liked = page.getByTestId('article-row')
    await expect(liked).toHaveCount(1)
    await liked.first().click()
    await expect(page).toHaveURL(new RegExp(`article=${articleId}(&|$)`))

    // The Liked list is defined by this button, so unliking has to empty it. Everywhere else the
    // button holds the whole truth and no render is owed.
    await page.getByTestId('like-button').click()
    await expect(page.getByTestId('like-button')).toHaveAttribute('aria-pressed', 'false')
    await expect(page.getByTestId('article-row')).toHaveCount(0)
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
    const switcher = page.getByTestId('locale-switcher')
    await switcher.getByRole('button', { name: '中文' }).click()
    await expect(page.getByRole('link', { name: '阅读' })).toBeVisible()
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-Hans')
    await switcher.getByRole('button', { name: 'EN' }).click()
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

  test('a summary-only feed gets its full text fetched on first open', async ({ page }) => {
    await page.goto('/add')
    await page.getByTestId('feed-url').fill(`${FIXTURES}/summary.xml`)
    await page.getByTestId('find-feeds').click()
    const candidates = page.getByTestId('feed-candidates')
    await expect(candidates).toContainText('Summary Fixture')
    await candidates.getByTestId('subscribe').first().click()
    await expect(page).toHaveURL(/\/reading\?feed=\d+/)
    // The worker fetches the feed and learns from its three items that it is summary-only.
    const row = page.getByTestId('article-row').first()
    await expect(row).toBeVisible({ timeout: 45_000 })
    await row.click()
    await expect(page).toHaveURL(/article=\d+/)
    // Opening queues article.extract; the reader polls until the page body replaces the teaser.
    await expect(page.locator('.article-body')).toContainText('Full paragraph 8', {
      timeout: 45_000,
    })
    await expect(page.getByTestId('extracting')).toHaveCount(0)
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

test.describe('translation', () => {
  test('foreign articles show translated titles and open with a side-by-side translation', async ({
    page,
  }) => {
    // The Japanese feed added earlier was fetched by the worker, which queued title translations.
    await page.goto('/reading')
    const row = page.getByTestId('article-row').filter({ hasText: 'JA → EN' }).first()
    await expect(row).toBeVisible()
    // Title translations are queued after the fetch and the list does not live-update, so
    // reload until the worker (mock provider) has stored the translated title.
    await expect
      .poll(
        async () => {
          await page.reload()
          return (await row.locator('h2').textContent()) ?? ''
        },
        { timeout: 30_000, intervals: [1000] },
      )
      .toContain('en:')

    const renders: string[] = []
    const paneFetches: string[] = []
    page.on('request', (request) => {
      const path = new URL(request.url()).pathname
      if (path === '/reading' && request.headers()['next-router-prefetch'] !== '1') {
        renders.push(request.method())
      }
      if (path === '/api/reading/article') paneFetches.push(request.method())
    })
    await row.click()
    const bar = page.getByTestId('translation-bar')
    await expect(bar).toBeVisible()
    await expect(bar).toContainText('Written in Japanese')
    // Requested on open; the mock provider answers within seconds.
    await expect(bar).toHaveAttribute('data-state', /done|partial/, { timeout: 30_000 })
    await expect(page.getByTestId('body-translated')).toContainText('en:')
    await expect(page.getByTestId('body-original')).toBeVisible()
    await expect(page.getByTestId('article-title')).toContainText('en:')
    // Opening the article and watching its translation land costs no page render at all: the pane
    // is fetched once on the click and once more when the translation becomes displayable, both
    // from the route handler. Transient pending/requested/running states must move neither.
    expect(renders.filter((method) => method === 'GET')).toHaveLength(0)
    expect(paneFetches.length).toBeGreaterThanOrEqual(2)

    await page.getByTestId('mode-trans').click()
    await expect(page.getByTestId('reader')).toHaveAttribute('data-mode', 'trans')
    await expect(page.getByTestId('body-original')).toHaveCount(0)
    await page.getByTestId('mode-orig').click()
    await expect(page.getByTestId('body-translated')).toHaveCount(0)
    await expect(page.getByTestId('article-title')).not.toContainText('en:')
    await expect(page).toHaveURL(/mode=orig/)

    // Mode is URL state: closing and going back must restore the same view without a page render.
    await page.getByTestId('close-article').click()
    await expect(page).not.toHaveURL(/article=/)
    await page.goBack()
    await expect(page).toHaveURL(/article=\d+.*mode=orig/)
    await expect(page.getByTestId('reader')).toHaveAttribute('data-mode', 'orig')
    await expect(page.getByTestId('body-original')).toBeVisible()
    await expect(page.getByTestId('body-translated')).toHaveCount(0)
  })

  test('switching the reading language changes what gets translated', async ({ page }) => {
    await page.goto('/reading')
    await page.getByTestId('read-in').getByRole('button', { name: 'ZH' }).click()
    await expect(page.getByTestId('read-in').getByRole('button', { name: 'ZH' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    // An English feed is now foreign.
    await page.getByTestId('subscription').filter({ hasText: 'Julia Evans' }).click()
    await expect(page.getByTestId('article-row').first()).toContainText('EN → ZH')
    await page.getByTestId('read-in').getByRole('button', { name: 'EN' }).click()
    await expect(page.getByTestId('article-row').first()).not.toContainText('EN → ZH')
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

    // All fixture feeds share one origin, so the site carries the first feed's title.
    await page.goto('/discover')
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

    await page.goto('/discover?topic=tech')
    await expect(page.getByTestId('site-card')).toHaveCount(1)
    await page.goto('/discover?topic=food')
    await expect(page.getByTestId('site-card')).toHaveCount(0)

    // Subscribe/unsubscribe from the card keeps reader counts in step.
    await page.goto('/discover')
    const button = page.getByTestId('site-card').first().getByTestId('site-subscribe')
    const wasSubscribed = (await button.getAttribute('aria-pressed')) === 'true'
    await button.click()
    await expect(
      page.getByTestId('site-card').first().getByTestId('site-subscribe'),
    ).toHaveAttribute('aria-pressed', wasSubscribed ? 'false' : 'true')
  })
})

test.describe('recommendations, profile, dashboard, settings', () => {
  test('recommend with a note, see it on the profile and in the author dashboard', async ({
    page,
  }) => {
    await page.goto('/reading')
    await page.getByTestId('article-row').first().click()
    // The reader shows the translated title (the mock prefixes "en:"); the public profile shows
    // the original, so compare on the untranslated part.
    const title = ((await page.getByTestId('article-title').textContent())?.trim() ?? '').replace(
      /^[a-zA-Z-]+:/,
      '',
    )
    await page.getByTestId('recommend-button').click()
    await page.getByTestId('recommend-note').fill('Worth your time, especially the ending.')
    await page.getByTestId('recommend-submit').click()
    await expect(page.getByTestId('toast')).toContainText('Recommended with your note')
    await expect(page.getByTestId('recommend-button')).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByTestId('recommend-button')).toContainText('1')

    await page.getByTestId('nav-profile').click()
    await expect(page).toHaveURL(/\/@[a-z0-9_]+$/)
    const recs = page.getByTestId('profile-recommendations')
    await expect(recs).toContainText(title.slice(0, 20))
    await expect(recs).toContainText('Worth your time')

    // The development user claimed the fixture site earlier, so the note reaches the dashboard.
    await page.getByTestId('nav-dashboard').click()
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
  })

  test('OPML export lists the subscriptions', async ({ request }) => {
    const res = await request.get('/settings/opml')
    expect(res.status()).toBe(200)
    expect(res.headers()['content-type']).toContain('opml')
    const body = await res.text()
    expect(body).toContain('<opml version="2.0">')
    expect(body).toContain('xmlUrl="http://127.0.0.1:4790/jvns.xml"')
  })
})

test.describe('search', () => {
  test('finds blogs by name and posts in subscriptions by title', async ({ page }) => {
    await page.goto('/reading')
    const firstTitle =
      (await page.getByTestId('article-row').first().locator('h2').textContent())?.trim() ?? ''
    const original = firstTitle.replace(/^[a-zA-Z-]+:/, '')
    const word = original.split(/\s+/).find((w) => w.length >= 4) ?? original.slice(0, 4)

    const input = page.getByTestId('search-input')
    await input.fill('Julia')
    await input.press('Enter')
    await expect(page).toHaveURL(/\/search\?q=Julia$/)
    // Every fixture feed belongs to the one fixture site, so "Julia" matches through a feed title.
    await expect(page.getByTestId('site-card').first()).toBeVisible()
    await expect(page.getByTestId('search-input')).toHaveValue('Julia')
    await page.getByTestId('search-input').fill('胡涂')
    await page.getByTestId('search-input').press('Enter')
    await expect(page.getByTestId('site-card').filter({ hasText: '胡涂说' })).toBeVisible()

    await page.getByTestId('search-input').fill(word)
    await page.getByTestId('search-input').press('Enter')
    const hit = page.getByTestId('article-hit').first()
    await expect(hit).toContainText(word)
    await hit.click()
    await expect(page).toHaveURL(/\/reading\?feed=\d+&article=\d+/)

    await page.goto('/search?q=zzzz-nothing-here')
    await expect(page.getByTestId('search-empty')).toBeVisible()
  })
})

test.describe('websub', () => {
  test('the worker subscribes at the feed’s hub; the callback verifies intent and accepts signed pings', async ({
    page,
    request,
  }) => {
    await page.goto('/add')
    await page.getByTestId('feed-url').fill(`${FIXTURES}/hubbed.xml`)
    await page.getByTestId('find-feeds').click()
    await page.getByTestId('feed-candidates').getByTestId('subscribe').first().click()
    await expect(page).toHaveURL(/\/reading\?feed=\d+/)
    const feedId = page.url().match(/feed=(\d+)/)?.[1]

    type HubState = {
      subscriptions: Array<{
        mode: string
        topic: string
        callback: string
        leaseSeconds: number
        verifyStatus: number | null
        verified: boolean
      }>
    }
    const hub = async () => (await (await request.get(`${FIXTURES}/__hub`)).json()) as HubState
    // The worker fetches the feed, sees the hub link, and subscribes; the hub verifies our callback.
    await expect
      .poll(async () => (await hub()).subscriptions.filter((s) => s.verified).length, {
        timeout: 45_000,
      })
      .toBeGreaterThan(0)
    const state = await hub()
    const i = state.subscriptions.findIndex((s) => s.verified)
    const sub = state.subscriptions[i]
    expect(sub).toMatchObject({
      mode: 'subscribe',
      topic: `${FIXTURES}/hubbed.xml`,
      leaseSeconds: 864_000,
      verifyStatus: 200,
    })
    expect(sub?.callback).toMatch(new RegExp(`/api/websub/${feedId}$`))

    const ping = (await (await request.post(`${FIXTURES}/__hub/notify?i=${i}`)).json()) as {
      status: number
    }
    expect(ping.status).toBe(204)

    const forged = await request.post(sub?.callback ?? '', {
      headers: { 'x-hub-signature': `sha256=${'ab'.repeat(32)}`, 'content-type': 'text/xml' },
      data: '<feed/>',
    })
    expect(forged.status()).toBe(403)
    const unknown = await request.get(
      '/api/websub/999999?hub.mode=subscribe&hub.topic=x&hub.challenge=c',
    )
    expect(unknown.status()).toBe(404)
    const wrongTopic = await request.get(
      `${sub?.callback}?hub.mode=subscribe&hub.topic=http://x/other&hub.challenge=c`,
    )
    expect(wrongTopic.status()).toBe(404)
  })
})

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
    // Discover opens on This week (ADR 0044), its tabs links that work without a script.
    await expect(page.getByTestId('discover-tab-week')).toHaveAttribute('aria-current', 'page')
    await expect(page.getByTestId('week-span')).toHaveAttribute(
      'data-span',
      /^(recommended|week|latest)$/,
    )
    // Followed by address: without a script, a click waits on frames that never come.
    await expect(page.getByTestId('discover-tab-blogs')).toHaveAttribute('href', '/discover/blogs')
    await page.goto('/discover/blogs')
    await expect(page).toHaveTitle('Blogs · Discover · Tela')
    await expect(page.getByTestId('topic-chips')).toBeVisible()
    // An address from before the tabs is the Blogs page now, its query kept.
    await page.goto('/discover?topic=tech')
    await expect(page).toHaveURL(/\/discover\/blogs\?topic=tech$/)
    // The visitor's header (ADR 0035): Log in and Join are links, so they work without a script.
    const banner = page.getByRole('banner')
    await expect(banner.getByRole('link', { name: 'Log in', exact: true })).toHaveAttribute(
      'href',
      '/login',
    )
    await expect(banner.getByRole('link', { name: 'Join', exact: true })).toHaveAttribute(
      'href',
      '/join',
    )
    await expect(page.getByTestId('language-menu')).toBeVisible()
    await expect(page.getByTestId('nav-reading')).toHaveCount(0)

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

  // The single-page fallback answers a path with no file 200 with the app's HTML (AGENTS.md), so
  // a 200 alone proves nothing: each must come back as what its name says.
  test('the manifest and its icons are served as themselves, and every page names it', async ({
    page,
    request,
  }) => {
    const res = await request.get('/manifest.webmanifest')
    expect(res.status()).toBe(200)
    expect(res.headers()['content-type']).toMatch(/^application\/manifest\+json\b/)
    const manifest = (await res.json()) as { start_url: string; icons: { src: string }[] }
    expect(manifest.icons.length).toBeGreaterThan(0)
    for (const { src } of manifest.icons) {
      const icon = await request.get(src)
      expect(icon.status(), src).toBe(200)
      expect(icon.headers()['content-type'], src).toBe('image/png')
    }
    // The shell, served without the Worker, and a page the edge rendered into it.
    for (const path of [manifest.start_url, '/about']) {
      await page.goto(path)
      await expect(page.locator('link[rel="manifest"]'), path).toHaveAttribute(
        'href',
        '/manifest.webmanifest',
      )
    }
    await expect(page.getByTestId('info-page')).toBeVisible()
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
    // The profile link is one for the footer, and GitHub waits on linking it in Settings.
    await expect(page.getByTestId('rel-me-snippet')).toContainText('<a rel="me" href=')
    await expect(page.getByTestId('claim-github').getByRole('link')).toHaveAttribute(
      'href',
      '/settings',
    )

    const stop = keepCycling(page)
    try {
      // Verify before the tag exists: a clear failure.
      await page.getByTestId('claim-verify').click()
      await expect(page.getByTestId('claim-page')).toHaveAttribute('data-status', 'failed', {
        timeout: 30_000,
      })
      // Worded on the page from the reason the check stored, not the check's own English.
      await expect(page.getByTestId('claim-error')).toContainText('no meta tag')
      await expect(page.getByTestId('claim-error')).not.toContainText('{"reason"')

      // Publish the token on the fixture home page and verify again.
      const set = await request.post(`${FIXTURES}/__claim-token?token=${token}`)
      expect(set.status()).toBe(204)
      await page.getByTestId('claim-verify').click()
      await expect(page.getByTestId('claim-verified')).toBeVisible({ timeout: 30_000 })
    } finally {
      stop()
    }

    await page.getByRole('link', { name: 'Discover' }).first().click()
    await page.getByTestId('discover-tab-blogs').click()
    const card = page.locator(`[data-testid="site-card"][data-site-id="${siteId}"]`)
    await expect(card).toBeVisible()
    await expect(card.getByTestId('claimed-badge')).toBeVisible()
    // Only the e2e member reads it, and a count below three is nobody's to publish (ADR 0041):
    // tela-api keeps it back, and the card and the blog's page say nothing of readers.
    const discover = (await (await request.get('/api/v1/public/discover')).json()) as {
      sites: { id: number; readerCount: number | null }[]
    }
    expect(discover.sites.find((s) => s.id === Number(siteId))?.readerCount).toBeNull()
    await expect(card).not.toContainText(/reader/)
    await expect(card).toContainText(/Posts|Quiet/)
    await expect(page.getByTestId('topic-chips')).toContainText('Tech')
    await card.locator('a[href^="/s/"]').first().click()
    await expect(page.getByTestId('site-articles')).toBeVisible()
    await expect(page.getByRole('main')).not.toContainText(/readers? on Tela/)
  })

  test('the site page lets the owner set topics, and Discover filters by them', async ({
    page,
  }) => {
    await page.goto('/discover/blogs')
    // The member's own blog, claimed above: featured blogs sort before it, whichever specs ran.
    const own = page.getByTestId('site-card').filter({ has: page.getByTestId('claimed-badge') })
    await own.first().locator('a[href^="/s/"]').first().click()
    await expect(page).toHaveURL(/\/s\/\d+$/)
    await expect(page.getByTestId('site-articles')).toBeVisible()
    const form = page.getByTestId('topics-form')
    await form.getByLabel('Tech').check()
    await form.getByRole('button', { name: 'Save' }).click()
    await expect(page.locator('a[href="/discover/blogs?topic=tech"]')).toBeVisible()

    await page.getByRole('link', { name: 'Discover' }).first().click()
    await page.getByTestId('discover-tab-blogs').click()
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
    await page.goto('/discover/blogs')
    await page.getByTestId('site-card').first().locator('a[href^="/s/"]').first().click()
    const post = page.getByTestId('site-articles').getByRole('link').first()
    const title = (await post.textContent())?.trim() ?? ''
    await post.click()
    await expect(page).toHaveURL(/\/reading\?.*article=\d+/)
    await expect(page.getByTestId('article-title')).toHaveText(title)
  })

  test('a check that runs long says so, and the member may ask for another', async ({ page }) => {
    // tela-jobs never answers: the check is waiting to retry, as after a failed attempt.
    const pending = {
      siteId: 999_999,
      homeUrl: 'https://blog.example',
      status: 'pending',
      error: null,
      reason: null,
      github: false,
      proofs: {
        meta: '<meta name="tela-site-verification" content="0">',
        relMe: '<a rel="me" href="https://tela.test/@e2e">Tela</a>',
      },
    }
    await page.route('**/api/v1/claims/999999**', (route) => route.fulfill({ json: pending }))
    await page.clock.install()
    await page.goto('/sites/999999/claim')
    const checking = page.getByTestId('claim-checking')
    const verify = page.getByTestId('claim-verify')
    await expect(checking).toHaveText('Checking your site…')
    await expect(verify).toBeDisabled()

    // Past the two minutes the page asks for: it stops, says so, and offers a fresh check.
    await page.clock.fastForward(125_000)
    await expect(checking).toContainText('taking longer than usual')
    await expect(verify).toBeEnabled()
    await expect(verify).toHaveText('Verify again')
    await verify.click()
    await expect(checking).toHaveText('Checking your site…')
    await expect(verify).toBeDisabled()
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
    // one the browser cached (a minute fresh, PROFILE_CACHE), are forgotten once the server has
    // the change. A fresh load first: the rename above has already sent this page past the cache.
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

  test('a page the edge rendered is never replaced by an older copy the browser kept', async ({
    browser,
    request,
  }) => {
    const headers = { origin: BASE, ...(await memberHeaders(request)) }
    const save = async (bio: string) => {
      const res = await request.put(`${BASE}/api/v1/profile`, {
        headers,
        data: { handle: 'devreader', displayName: 'Dev Reader', bio },
      })
      expect(res.ok()).toBe(true)
    }
    // A visitor, signed out (a new context takes the project's member state unless told): the
    // member's own device forgets its copies of their profile when it changes (app.tsx), which
    // would hide what this is about.
    const visitor = await browser.newContext({
      baseURL: BASE,
      storageState: { cookies: [], origins: [] },
    })
    const page = await visitor.newPage()
    const before = `Before ${Date.now()}`
    const after = `After ${Date.now()}`
    await save(before)
    // The browser keeps this answer, fresh for a minute (PROFILE_CACHE). No page.route anywhere
    // here: routing turns Playwright's HTTP cache off, and with it what this is about.
    await page.goto('/discover')
    const kept = await page.evaluate(async () => {
      const res = await fetch('/api/v1/public/profiles/devreader')
      return res.text()
    })
    expect(kept).toContain(before)
    await save(after)
    // A whole load: the page is rendered from what tela-api says now, or the edge's copy of it,
    // and its data is asked for again behind it. The browser's copy is older than both.
    await page.goto('/@devreader')
    await expect(page.getByTestId('profile-page')).toContainText(after)
    await page.waitForTimeout(1000)
    await expect(page.getByTestId('profile-page')).toContainText(after)
    await visitor.close()
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

test.describe('Discover past one page', () => {
  test.use({ storageState: { cookies: [], origins: [] } })

  test('the pager opens each page at its top, held or not', async ({ page }) => {
    // 110 blogs, as the editorial list has, without listing 110 in the stack every spec shares.
    const site = (id: number) => ({
      id,
      title: `Blog ${id}`,
      homeUrl: `https://blog${id}.example`,
      description: null,
      faviconKey: null,
      primaryLang: 'en',
      claimed: false,
      readerCount: null,
      feedId: id,
      latestTitle: `Post ${id}`,
      latestAt: null,
      postsLast30d: 0,
      topics: [],
    })
    await page.route(/\/api\/v1\/public\/discover(\?|$)/, async (route) => {
      const n = Number(new URL(route.request().url()).searchParams.get('page') ?? 1)
      const ids = Array.from({ length: n === 1 ? 60 : 50 }, (_, i) => (n - 1) * 60 + i + 1)
      await route.fulfill({
        json: {
          sites: ids.map(site),
          languages: [{ lang: 'en', count: 110 }],
          total: 110,
          page: n,
          pageSize: 60,
        },
      })
    })
    // Into Discover's Blogs from inside the app, so every page comes through the route above, not
    // the edge's handover.
    await page.goto('/about')
    await page.getByRole('banner').getByRole('link', { name: 'Discover' }).click()
    await page.getByTestId('discover-tab-blogs').click()
    const cards = page.getByTestId('site-card')
    const pager = page.getByTestId('discover-pager')
    await expect(cards).toHaveCount(60)

    const turn = async (name: RegExp, first: string, count: number) => {
      await pager.scrollIntoViewIfNeeded()
      expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(1000)
      await pager.getByRole('link', { name }).click()
      await expect(cards).toHaveCount(count)
      await expect(cards.first()).toContainText(first)
      await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0)
    }
    await turn(/Next/, 'Blog 61', 50)
    await turn(/Previous/, 'Blog 1', 60)
    // Page 2 is held now and renders at once: the scroll it inherited was the regression.
    await turn(/Next/, 'Blog 61', 50)
  })
})

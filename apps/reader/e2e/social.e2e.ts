/**
 * Readers following readers (ADR 0031, Tela v2): a second member who recommends, likes and reads
 * in public, followed from their profile by the setup's member, whose Following page then shows
 * what they did. Nothing of theirs reaches the follower's device but the follow itself.
 */
import { type APIRequestContext, expect, request, test } from '@playwright/test'
import { ADMIN_TOKEN, BASE, FIXTURES, memberHeaders, signInRequest } from './helpers'

const OTHER = 'anna@e2e.test'
const HANDLE = 'anna_e2e'
const NOTE = 'Read this one slowly; the ending is worth it.'
/** The blog she reads, made public in the setup so it has a page. */
let siteId = 0

/** One of the member's own calls, from their own context, as the app makes them. */
async function push(api: APIRequestContext, mutations: Record<string, unknown>[]) {
  const res = await api.post(`${BASE}/api/v1/mutations`, {
    headers: { origin: BASE, ...(await memberHeaders(api)) },
    data: {
      mutations: mutations.map((m) => ({ mid: crypto.randomUUID(), at: Date.now(), ...m })),
    },
  })
  expect(res.ok()).toBe(true)
}

test.beforeAll(async () => {
  // Signing in is three tries a minute per address: this member comes from one of their own.
  const anna = await request.newContext({
    baseURL: BASE,
    extraHTTPHeaders: { 'cf-connecting-ip': '198.51.100.40' },
  })
  try {
    await signInRequest(anna, OTHER)
    const named = await anna.put(`${BASE}/api/v1/profile`, {
      headers: { origin: BASE, ...(await memberHeaders(anna)) },
      data: { handle: HANDLE, displayName: 'Anna Kowalska', bio: 'Architect. Reads about cities.' },
    })
    expect(named.ok()).toBe(true)
    // She reads Julia Evans, which the setup's member reads too; the feed is already in Tela.
    const added = await anna.post(`${BASE}/api/v1/feeds`, {
      headers: { origin: BASE, ...(await memberHeaders(anna)) },
      data: { feedUrl: `${FIXTURES}/jvns.xml` },
    })
    expect(added.ok()).toBe(true)
    const pulled = (await (
      await anna.get(`${BASE}/api/v1/sync?cursor=0`, { headers: await memberHeaders(anna) })
    ).json()) as { rows: { articles: { id: number; feedId: number }[] } }
    const [first, second] = pulled.rows.articles
    if (!first || !second) throw new Error('the fixture feed has no posts')
    // A blog nobody claimed has no public page; an operator featuring it gives it one.
    const curated = await anna.post(`${BASE}/api/admin/curate`, {
      headers: { origin: BASE, authorization: `Bearer ${ADMIN_TOKEN}` },
      data: { feedUrl: `${FIXTURES}/jvns.xml`, topics: [] },
    })
    expect(curated.ok()).toBe(true)
    siteId = ((await curated.json()) as { siteId: number }).siteId
    await push(anna, [
      { type: 'recommend', articleId: first.id, note: NOTE },
      { type: 'setLiked', articleId: second.id, liked: true },
      { type: 'setPrivacy', publicLikes: true, publicSubscriptions: true },
    ])
  } finally {
    await anna.dispose()
  }
})

test.describe('following', () => {
  test('follow from a profile, and the Following page shows what they passed on', async ({
    page,
  }) => {
    await page.goto(`/@${HANDLE}`)
    await expect(page.getByTestId('profile-page')).toContainText('Anna Kowalska')
    const follow = page.getByTestId('follow-button')
    await expect(follow).toHaveAttribute('aria-pressed', 'false')
    const pushed = page.waitForResponse((r) => r.url().includes('/api/v1/mutations') && r.ok())
    await follow.click()
    await expect(follow).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByTestId('profile-count-followers')).toContainText('1')
    await pushed

    await page.getByTestId('nav-following').click()
    await expect(page).toHaveURL(/\/following$/)
    await expect(page.getByTestId('people-you-follow')).toContainText('Anna Kowalska')
    const items = page.getByTestId('following-item')
    await expect(page.getByTestId('following-note')).toContainText(NOTE)
    await expect(items.filter({ hasText: 'liked a post' })).toHaveCount(1)
    // Her new subscription shows only if its blog is listed, which the fixture's may not be yet:
    // the API suite covers that rule (apps/api/test/social.test.ts).

    // Likes alone, then recommendations alone.
    await page.getByTestId('following-tab-likes').click()
    await expect(page).toHaveURL(/tab=likes/)
    await expect(items).toHaveCount(1)
    await expect(items.first()).toHaveAttribute('data-kind', 'liked')
    await page.getByTestId('following-tab-recs').click()
    await expect(items.first()).toHaveAttribute('data-kind', 'recommended')

    // A recommended post opens in the reader, whatever the device syncs.
    await items.first().getByRole('link', { name: /.+/ }).last().click()
    await expect(page).toHaveURL(/\/reading\?.*article=\d+/)
    await expect(page.getByTestId('reader')).toBeVisible()
  })

  test('a blog page names the readers I follow there, and what readers said of it', async ({
    page,
  }) => {
    await page.goto(`/s/${siteId}`)
    await expect(page.getByTestId('site-page')).toBeVisible()
    await expect(page.getByTestId('site-readers')).toContainText('Anna reads this blog.')
    await expect(page.getByTestId('site-notes')).toContainText(NOTE)
    await expect(page.getByTestId('site-notes')).toContainText('Anna Kowalska')
  })

  test('her public profile shows her likes and what she reads, to anyone', async ({ page }) => {
    await page.goto(`/@${HANDLE}?tab=liked`)
    await expect(page.getByTestId('profile-tab-liked')).toHaveAttribute('aria-current', 'page')
    await expect(page.getByTestId('profile-liked').locator('article')).toHaveCount(1)
    await page.getByTestId('profile-tab-subscriptions').click()
    await expect(page).toHaveURL(/tab=subscriptions/)
    // The fixture feeds share a site on the fixture server's host, named by whichever came first.
    await expect(page.getByTestId('profile-subscriptions').locator('li')).toHaveCount(1)
  })

  test('unfollowing empties the Following page', async ({ page }) => {
    await page.goto(`/@${HANDLE}`)
    const follow = page.getByTestId('follow-button')
    await expect(follow).toHaveAttribute('aria-pressed', 'true')
    const pushed = page.waitForResponse((r) => r.url().includes('/api/v1/mutations') && r.ok())
    await follow.click()
    await expect(follow).toHaveAttribute('aria-pressed', 'false')
    await pushed
    await page.getByTestId('nav-following').click()
    await expect(page.getByTestId('following-empty')).toBeVisible()
    await expect(page.getByTestId('people-you-follow')).not.toContainText('Anna Kowalska')
  })
})

test.describe('for a visitor', () => {
  test.use({ storageState: { cookies: [], origins: [] }, javaScriptEnabled: false })

  test('a profile tab is a whole page without JavaScript', async ({ page }) => {
    const res = await page.goto(`/@${HANDLE}?tab=liked`)
    expect(res?.status()).toBe(200)
    await expect(page.getByTestId('profile-liked').locator('article')).toHaveCount(1)
    // A visitor's Follow signs in first, and comes back.
    await expect(page.getByRole('link', { name: 'Follow' })).toHaveAttribute(
      'href',
      `/login?next=${encodeURIComponent(`/@${HANDLE}`)}`,
    )
  })
})

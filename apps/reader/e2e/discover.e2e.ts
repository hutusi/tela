/**
 * Discover's four tabs (ADR 0044): the same public pages for everyone, whole without JavaScript,
 * and what is the member's own worked out on their device. A second member recommends three posts
 * from blogs that wrote this week (`./fresh.ts`), two with notes, so the week leads with them and
 * she is a reader worth suggesting; the setup's member likes one of them, which only their device
 * matches against her.
 */
import { type APIRequestContext, expect, request, test } from '@playwright/test'
import { FRESH } from './fresh'
import {
  ADMIN_TOKEN,
  BASE,
  cycle,
  FIXTURES,
  memberHeaders,
  STATE_FILE,
  signInRequest,
} from './helpers'

const VISITOR = { storageState: { cookies: [], origins: [] } }
const OTHER = 'dora@e2e.test'
const HANDLE = 'dora_e2e'
const NAME = 'Dora Lindqvist'
const NOTES = ['The market post that made me want to visit.', 'Quiet, and worth the time.']
/** The fresh blogs she recommends from, and the one the setup's member subscribes to here. */
const RECOMMENDED = ['es', 'ja', 'zh'] as const
const SUBSCRIBED = 'en' as const

/** The posts she recommended, by language. */
const recommended: Partial<Record<(typeof RECOMMENDED)[number], number>> = {}

async function push(api: APIRequestContext, mutations: Record<string, unknown>[]) {
  const res = await api.post(`${BASE}/api/v1/mutations`, {
    headers: { origin: BASE, ...(await memberHeaders(api)) },
    data: {
      mutations: mutations.map((m) => ({ mid: crypto.randomUUID(), at: Date.now(), ...m })),
    },
  })
  expect(res.ok()).toBe(true)
}

/** The member's newest post of a feed, from a pull. */
async function newestOf(api: APIRequestContext, feedId: number): Promise<number> {
  const pulled = (await (
    await api.get(`${BASE}/api/v1/sync?cursor=0`, { headers: await memberHeaders(api) })
  ).json()) as { rows: { articles: { id: number; feedId: number; sortAt: number }[] } }
  const posts = pulled.rows.articles.filter((a) => a.feedId === feedId)
  posts.sort((a, b) => b.sortAt - a.sortAt)
  const id = posts[0]?.id
  if (!id) throw new Error(`feed ${feedId} has no posts`)
  return id
}

test.beforeAll(async () => {
  const admin = await request.newContext({ baseURL: BASE })
  const dora = await request.newContext({
    baseURL: BASE,
    extraHTTPHeaders: { 'cf-connecting-ip': '198.51.100.44' },
  })
  try {
    // Featured, as the visitor spec does: twice, since a feed's first fetch may move it to the
    // home it declares.
    const curate = async () => {
      for (const lang of [...RECOMMENDED, SUBSCRIBED]) {
        const res = await admin.post(`${BASE}/api/admin/curate`, {
          headers: { origin: BASE, authorization: `Bearer ${ADMIN_TOKEN}` },
          data: { feedUrl: `${FIXTURES}/fresh/${lang}.xml`, topics: [], featured: true },
        })
        expect(res.ok()).toBe(true)
      }
    }
    await curate()
    await cycle(admin)
    await curate()
    await cycle(admin)

    await signInRequest(dora, OTHER)
    const named = await dora.put(`${BASE}/api/v1/profile`, {
      headers: { origin: BASE, ...(await memberHeaders(dora)) },
      data: { handle: HANDLE, displayName: NAME, bio: 'Reads harbours and markets.' },
    })
    expect(named.ok()).toBe(true)
    for (const lang of RECOMMENDED) {
      const added = await dora.post(`${BASE}/api/v1/feeds`, {
        headers: { origin: BASE, ...(await memberHeaders(dora)) },
        data: { feedUrl: `${FIXTURES}/fresh/${lang}.xml` },
      })
      expect(added.ok()).toBe(true)
      const { feedId } = (await added.json()) as { feedId: number }
      recommended[lang] = await newestOf(dora, feedId)
    }
    await push(dora, [
      { type: 'recommend', articleId: recommended.es, note: NOTES[0] },
      { type: 'recommend', articleId: recommended.ja, note: NOTES[1] },
      { type: 'recommend', articleId: recommended.zh, note: null },
    ])
  } finally {
    await dora.dispose()
    await admin.dispose()
  }
})

test.describe('without JavaScript', () => {
  test.use({ ...VISITOR, javaScriptEnabled: false })

  test('the four tabs are whole pages, This week first', async ({ page }) => {
    const res = await page.goto('/discover')
    expect(res?.status()).toBe(200)
    expect(res?.headers()['x-robots-tag']).toBe('noindex, nofollow')
    const tabs = page.getByTestId('discover-tabs')
    await expect(tabs.getByRole('link')).toHaveCount(4)
    await expect(page.getByTestId('discover-tab-week')).toHaveAttribute('aria-current', 'page')
    await expect(page.getByTestId('discover-tab-articles')).toHaveAttribute(
      'href',
      '/discover/articles',
    )
    // Structure only: the colo may hold a copy rendered before this spec's recommendations.
    await expect(page.getByTestId('week-span')).toHaveAttribute(
      'data-span',
      /^(recommended|week|latest)$/,
    )
    await expect(page.locator('#tela-data')).toHaveCount(1)

    await page.goto('/discover/articles')
    await expect(page.getByTestId('discover-tab-articles')).toHaveAttribute('aria-current', 'page')
    await expect(page.getByTestId('articles-sort-new')).toHaveAttribute(
      'href',
      '/discover/articles?sort=new',
    )
    // A visitor's post goes to the original.
    const post = page.getByTestId('discover-post').first()
    await expect(post.getByRole('link', { name: /.+/ }).first()).toBeVisible()
  })

  test('an address from before the tabs is the Blogs page, its whole query kept', async ({
    page,
  }) => {
    await page.goto('/discover?topic=tech&via=github')
    await expect(page).toHaveURL(/\/discover\/blogs\?topic=tech&via=github$/)
    await expect(page.getByTestId('discover-tab-blogs')).toHaveAttribute('aria-current', 'page')
    await expect(page.getByTestId('topic-chips')).toBeVisible()
  })

  test('Readers suggests her for her notes, and following her is a sign-in', async ({ page }) => {
    await page.goto('/discover/readers')
    const card = page.locator(`[data-testid="reader-card"][data-handle="${HANDLE}"]`)
    // A visitor sees no group that needs a member's own likes or blogs.
    await expect(page.locator('[data-testid="reader-group"][data-group="shared"]')).toHaveCount(0)
    await expect(page.locator('[data-testid="reader-group"][data-group="blogs"]')).toHaveCount(0)
    if ((await card.count()) === 0) return // a copy the colo rendered before she recommended
    await expect(card).toContainText(NAME)
    await expect(card.getByRole('link', { name: 'Follow', exact: true })).toHaveAttribute(
      'href',
      /^\/login\?next=/,
    )
  })
})

test.describe('as a member', () => {
  test.afterAll(async () => {
    // Leave the setup's member as it was for the specs after this one.
    const api = await request.newContext({ baseURL: BASE, storageState: STATE_FILE })
    try {
      const pulled = (await (
        await api.get(`${BASE}/api/v1/sync?cursor=0`, { headers: await memberHeaders(api) })
      ).json()) as {
        rows: {
          follows: { userId: string; handle: string | null }[]
          subscriptions: { feedId: number }[]
          feeds: { id: number; feedUrl: string }[]
        }
      }
      const dora = pulled.rows.follows.find((f) => f.handle === HANDLE)
      const fresh = pulled.rows.feeds.find((f) => f.feedUrl.endsWith(`/fresh/${SUBSCRIBED}.xml`))
      await push(api, [
        { type: 'setLiked', articleId: recommended.es, liked: false },
        ...(dora ? [{ type: 'unfollow', userId: dora.userId }] : []),
        ...(fresh ? [{ type: 'unsubscribe', feedId: fresh.id }] : []),
      ])
    } finally {
      await api.dispose()
    }
  })

  test('the week leads with what she recommended, and a post opens in the reader', async ({
    page,
  }) => {
    await page.goto('/discover')
    await expect(page.getByTestId('week-span')).toHaveAttribute('data-span', 'recommended')
    const lead = page.getByTestId('week-lead')
    // The lead is a post like any other: its article id is on it or on the post inside it.
    const leadId = Number(
      await lead.evaluate(
        (el) =>
          (el.closest('[data-article-id]') ?? el.querySelector('[data-article-id]'))?.getAttribute(
            'data-article-id',
          ) ?? null,
      ),
    )
    expect(Object.values(recommended)).toContain(leadId)
    await lead.getByRole('link', { name: 'Read', exact: true }).click()
    await expect(page).toHaveURL(new RegExp(`/reading\\?.*article=${leadId}`))
    await expect(page.getByTestId('reader')).toBeVisible()
  })

  test('Readers matches her to a post the member liked, on the device, and a Follow keeps her card', async ({
    page,
  }) => {
    await push(page.request, [{ type: 'setLiked', articleId: recommended.es, liked: true }])
    await page.goto('/discover/readers')
    const shared = page.locator('[data-testid="reader-group"][data-group="shared"]')
    const card = shared.locator(`[data-testid="reader-card"][data-handle="${HANDLE}"]`)
    await expect(card).toContainText(NAME)
    await expect(card).toContainText('Also recommended')
    const pushed = page.waitForResponse((r) => r.url().includes('/api/v1/mutations') && r.ok())
    await card.getByRole('button', { name: 'Follow', exact: true }).click()
    await expect(card.getByRole('button', { name: 'Following', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    await pushed
    await expect(card).toBeVisible()
  })

  test('Articles says she recommended a post, and hides a blog the member reads', async ({
    page,
  }) => {
    const res = await page.request.post(`${BASE}/api/v1/feeds`, {
      headers: { origin: BASE, ...(await memberHeaders(page.request)) },
      data: { feedUrl: `${FIXTURES}/fresh/${SUBSCRIBED}.xml` },
    })
    expect(res.ok()).toBe(true)
    const answer = (await (
      await page.request.get(`${BASE}/api/v1/public/discover/articles`)
    ).json()) as { posts: { site: { id: number; title: string | null } }[] }
    const harbour = answer.posts.find((p) => p.site.title === FRESH[SUBSCRIBED].blog)?.site.id
    expect(harbour).toBeDefined()

    await page.goto('/discover/articles')
    const post = page.locator(`[data-testid="discover-post"][data-article-id="${recommended.es}"]`)
    await expect(post.getByTestId('post-reason')).toContainText(`${NAME}, whom you follow`)
    await expect(post.getByTestId('post-note')).toContainText(NOTES[0] as string)
    await expect(
      page.locator(`[data-testid="discover-post"][data-site-id="${harbour}"]`),
    ).toHaveCount(0)
  })
})

test.describe('More articles', () => {
  test.use(VISITOR)

  /** A post of the mocked answer: its own blog, nobody's subscription, no recommendations. */
  const mocked = (id: number) => ({
    article: {
      id: 900_000 + id,
      feedId: 900_000 + id,
      url: `https://mocked${id}.example/post`,
      title: `Mocked post ${id}`,
      author: null,
      publishedAt: 0,
      fetchedAt: 0,
      sortAt: 1_000_000 - id,
      sourceLang: 'en',
      excerpt: null,
      contentKey: null,
      wordCount: 0,
      readingMinutes: 1,
      extractState: 'done',
      likeCount: 0,
      recommendCount: 0,
      seq: 0,
      titles: {},
    },
    site: {
      id: 900_000 + id,
      title: `Mocked blog ${id}`,
      homeUrl: `https://mocked${id}.example`,
      faviconKey: null,
      primaryLang: 'en',
      claimed: false,
    },
    weekRecs: 0,
    recommenders: [],
    note: null,
  })
  const posts = (from: number, to: number) =>
    Array.from({ length: to - from + 1 }, (_, i) => mocked(from + i))

  test('a page asked for before leaving Articles is there on coming back', async ({ page }) => {
    await page.route(/\/api\/v1\/public\/discover\/articles(\?|$)/, async (route) => {
      if (new URL(route.request().url()).searchParams.has('cursor')) {
        // Slow enough for the member to go to another tab and back while it is out.
        await new Promise((resolve) => setTimeout(resolve, 1500))
        return route.fulfill({
          json: { recommended: [], posts: posts(31, 35), next: null, languages: [] },
        })
      }
      return route.fulfill({
        json: { recommended: [], posts: posts(1, 30), next: '999970:900030', languages: [] },
      })
    })
    await page.goto('/discover/blogs')
    // From the tab, so the app asks for Articles itself, past the edge's page.
    await page.getByTestId('discover-tab-articles').click()
    await expect(page.getByTestId('discover-post')).toHaveCount(30)
    const asked = page.waitForRequest((r) => r.url().includes('cursor='))
    await page.getByTestId('articles-more').click()
    await asked
    await page.getByTestId('discover-tab-blogs').click()
    await expect(page.getByTestId('discover-tab-blogs')).toHaveAttribute('aria-current', 'page')
    await page.getByTestId('discover-tab-articles').click()
    await expect(page.getByTestId('discover-post')).toHaveCount(35)
    await expect(page.getByTestId('articles-more')).toHaveCount(0)
  })
})

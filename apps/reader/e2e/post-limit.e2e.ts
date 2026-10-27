/**
 * The day's limit on posts from blogs a member does not subscribe to (ADR 0066), as the reader
 * shows it: posts opened from a public blog page are read in full up to the limit, and the next
 * shows its excerpt, the limit, Subscribe to keep reading and Read it on the blog, and stays
 * unread; subscribing from there opens it. A subscribed blog's posts are never counted. And no
 * public page hands anyone a content key, so the limit cannot be walked around from one.
 *
 * The limit is 1 for this spec (the setup lifts it for the member every spec shares), and the
 * member is new, so the day's count starts at nothing. The fixture feeds are one blog on the
 * fixture server's origin: the member subscribes to hutusi's feed and not to jvns's, and opens
 * both from that blog's page, featured as the admin spec features it. It leaves both at the end:
 * the public spec holds that blog's reader count below three.
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
import {
  ADMIN_TOKEN,
  addFeed,
  BASE,
  FIXTURES,
  memberHeaders,
  STATE_FILE,
  setSetting,
  signInRequest,
} from './helpers'

const LIMIT = 'member.unsubscribedPostsPerDay'
const NOBODY = { cookies: [], origins: [] }

/** A post on the blog's public page: no content key, which no public answer carries now. */
type Post = {
  id: number
  feedId: number
  title: string
  excerpt: string | null
  url: string | null
}

let siteId = 0
/** The blog's two feeds: jvns's, which the member does not subscribe to, and hutusi's. */
const feedIds = { jvns: 0, hutusi: 0 }
/** On the blog page's first page, with a body: jvns's, which the member does not subscribe to. */
let unfollowed: Post[] = []
/** …and hutusi's, which they do. */
let followed: Post[] = []
/** Every content key the shared member's device holds: the blog page's posts' among them. */
let keys: string[] = []

test.beforeAll(async () => {
  const setup = await request.newContext({ baseURL: BASE, storageState: STATE_FILE })
  try {
    await setSetting(setup, LIMIT, 1)
    const curated = await setup.post(`${BASE}/api/admin/curate`, {
      headers: { origin: BASE, authorization: `Bearer ${ADMIN_TOKEN}` },
      data: { feedUrl: `${FIXTURES}/jvns.xml`, topics: ['tech'], featured: true },
    })
    expect(curated.ok()).toBe(true)
    const { siteId: site, feedId: jvns } = (await curated.json()) as {
      siteId: number
      feedId: number
    }
    siteId = site
    feedIds.jvns = jvns
    const pulled = await setup.get(`${BASE}/api/v1/sync?cursor=0`, {
      headers: await memberHeaders(setup),
    })
    const { rows } = (await pulled.json()) as {
      rows: {
        feeds: { id: number; feedUrl: string }[]
        articles: { id: number; contentKey: string | null }[]
      }
    }
    const keyOf = new Map(rows.articles.map((a) => [a.id, a.contentKey]))
    keys = [...keyOf.values()].filter((k): k is string => typeof k === 'string')
    const hutusi = rows.feeds.find((f) => f.feedUrl.endsWith('/hutusi.xml'))?.id
    feedIds.hutusi = hutusi ?? 0
    const { posts } = (await (await setup.get(`${BASE}/api/v1/public/sites/${site}`)).json()) as {
      posts: Post[]
    }
    const withBody = (p: Post) => typeof keyOf.get(p.id) === 'string'
    unfollowed = posts.filter((p) => p.feedId === jvns && withBody(p))
    followed = posts.filter((p) => p.feedId === hutusi && withBody(p))
    expect(unfollowed.length, "jvns's posts on the blog page").toBeGreaterThanOrEqual(2)
    expect(followed.length, "hutusi's posts on the blog page").toBeGreaterThanOrEqual(2)
  } finally {
    await setup.dispose()
  }
})

test.afterAll(async () => {
  const operator = await request.newContext({ baseURL: BASE })
  try {
    await setSetting(operator, LIMIT, null)
  } finally {
    await operator.dispose()
  }
})

/** A new member, from an address of their own, subscribed to hutusi's feed only. */
async function newMember(
  browser: Browser,
): Promise<{ context: BrowserContext; api: APIRequestContext; page: Page }> {
  const context = await browser.newContext({
    baseURL: BASE,
    storageState: NOBODY,
    extraHTTPHeaders: { 'cf-connecting-ip': '100.64.2.1' },
  })
  await signInRequest(context.request, `post-limit-${Date.now()}@e2e.test`)
  await addFeed(context.request, `${FIXTURES}/hutusi.xml`)
  return { context, api: context.request, page: await context.newPage() }
}

/** The cursor of a snapshot: what a delta pulled from it later brings is what changed since. */
/**
 * Unsubscribe from the blog's feeds, as the member could: the public spec holds the fixture blog's
 * reader count below three, and this member is no reader it expects.
 */
async function leave(api: APIRequestContext): Promise<void> {
  const res = await api.post(`${BASE}/api/v1/mutations`, {
    headers: { origin: BASE, ...(await memberHeaders(api)) },
    data: {
      mutations: Object.values(feedIds).map((feedId) => ({
        mid: crypto.randomUUID(),
        at: Date.now(),
        type: 'unsubscribe',
        feedId,
      })),
    },
  })
  expect(res.ok()).toBe(true)
}

async function cursorNow(api: APIRequestContext): Promise<number> {
  const res = await api.get(`${BASE}/api/v1/sync?cursor=0`, { headers: await memberHeaders(api) })
  return ((await res.json()) as { cursor: number }).cursor
}

/**
 * When each post the member's states changed since `cursor` was read, from tela-api: a snapshot
 * sends no state of a post outside the member's feeds, a delta every state that changed.
 */
async function readSince(api: APIRequestContext, cursor: number): Promise<Map<number, unknown>> {
  const read = new Map<number, unknown>()
  for (let at = cursor; ; ) {
    const res = await api.get(`${BASE}/api/v1/sync?cursor=${at}`, {
      headers: await memberHeaders(api),
    })
    const body = (await res.json()) as {
      cursor: number
      more: boolean
      rows: { states: { articleId: number; readAt: number | null }[] }
    }
    for (const s of body.rows.states) read.set(s.articleId, s.readAt)
    if (!body.more) return read
    at = body.cursor
  }
}

test('one post a day in full from a blog not subscribed to; the next is its excerpt and a way to subscribe', async ({
  browser,
}) => {
  const { context, api, page } = await newMember(browser)
  try {
    const start = await cursorNow(api)
    const [first, second] = unfollowed as [Post, Post]
    const original = page.getByTestId('body-original').first()
    const refused = page.getByTestId('body-refused')
    /** Open a post from the blog page, as a member does: the reader fetches its row by id. */
    const open = async (post: Post) => {
      await page.goto(`/s/${siteId}`)
      // A member's link, once the app has taken the page over from the edge's.
      await page.getByTestId('site-articles').locator(`a[href$="article=${post.id}"]`).click()
      await expect(page).toHaveURL(new RegExp(`[?&]article=${post.id}$`))
      await expect(page.getByTestId('article-title')).toBeVisible()
    }

    await open(first)
    await expect(original).toBeVisible()
    await expect(refused).toHaveCount(0)

    await open(second)
    await expect(refused).toBeVisible()
    await expect(refused).toContainText('You’ve reached today’s limit')
    await expect(refused).toContainText('You can open 1 post a day in full')
    if (second.excerpt) await expect(refused).toContainText(second.excerpt.slice(0, 24))
    await expect(page.getByTestId('post-limit-subscribe')).toHaveText('Subscribe to keep reading')
    const onBlog = page.getByTestId('post-limit-blog')
    await expect(onBlog).toContainText('Read it on the blog')
    await expect(onBlog).toHaveAttribute('href', second.url ?? '')
    await expect(page.getByTestId('body-original')).toHaveCount(0)

    // The first was read by opening it; the refused one was not.
    await expect
      .poll(async () => (await readSince(api, start)).get(first.id) ?? null)
      .not.toBeNull()
    expect((await readSince(api, start)).get(second.id) ?? null).toBeNull()

    // A subscribed blog's posts open in full whatever the day's count says.
    for (const post of followed.slice(0, 2)) {
      await open(post)
      await expect(original).toBeVisible()
      await expect(refused).toHaveCount(0)
    }

    // Back to the refused post: still refused, still unread, until the member subscribes from it.
    await open(second)
    await expect(refused).toBeVisible()
    expect((await readSince(api, start)).get(second.id) ?? null).toBeNull()
    await page.getByTestId('post-limit-subscribe').click()
    await expect(original).toBeVisible()
    await expect(refused).toHaveCount(0)
    await expect
      .poll(async () => (await readSince(api, start)).get(second.id) ?? null)
      .not.toBeNull()
  } finally {
    await leave(api)
    await context.close()
  }
})

test('a visitor’s Discover and blog page carry no content key, in the page or its handover', async () => {
  const visitor = await request.newContext({ baseURL: BASE, storageState: NOBODY })
  try {
    for (const path of ['/discover', `/s/${siteId}`]) {
      const res = await visitor.get(path)
      expect(res.status(), path).toBe(200)
      const html = await res.text()
      const handover = html.match(
        /<script id="tela-data" type="application\/json">([^<]*)<\/script>/,
      )
      expect(handover, `${path} hands its data over`).not.toBeNull()
      expect(html, path).not.toMatch(/"contentKey":\s*"[0-9a-f]{32}"/)
      expect(
        keys.filter((key) => html.includes(key)),
        `${path} names no post's body`,
      ).toEqual([])
      if (path.startsWith('/s/')) {
        // The posts a member opens from it are there, by id, and nothing more.
        const { body } = JSON.parse(handover?.[1] ?? '{}') as {
          body: { posts: Record<string, unknown>[] }
        }
        expect(body.posts.map((p) => p.id)).toEqual(
          expect.arrayContaining(unfollowed.map((p) => p.id)),
        )
        for (const post of body.posts) expect(post.contentKey ?? null).toBeNull()
      }
    }
  } finally {
    await visitor.dispose()
  }
})

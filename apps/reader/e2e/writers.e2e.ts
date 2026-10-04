/**
 * For writers: the example card is a member's live public profile (`@hutusi`, seeded here with a
 * bio, a recommendation with a note and public subscriptions), the handle is checked as the
 * visitor types, and "Claim your card" carries the card through the sheet: the new member's
 * handle and name are set, and the claim starts from the blog they gave. A member gets the ways
 * on instead of the form. Each signing-in context comes from its own address, since better-auth
 * and `/api/v1/join` count tries per IP.
 */
import { type APIRequestContext, expect, request, test } from '@playwright/test'
import {
  adminCode,
  BASE,
  expectHeaderFits,
  FIXTURES,
  latestCode,
  measureHeader,
  memberHeaders,
  signInRequest,
} from './helpers'

const EXAMPLE = 'hutusi@e2e.test'
const NAME = 'Hu Tusi'
const BIO = 'Writes about reading, slowly, in two languages.'
const NOTE = 'The debugging post I keep coming back to.'

const ORIGIN = { origin: BASE }
const visitor = (n: number) => ({
  storageState: { cookies: [], origins: [] },
  extraHTTPHeaders: { 'cf-connecting-ip': `198.51.100.${n}` },
})

/** One of the member's own calls, from their own context, as the app makes them. */
async function push(api: APIRequestContext, mutations: Record<string, unknown>[]) {
  const res = await api.post(`${BASE}/api/v1/mutations`, {
    headers: { ...ORIGIN, ...(await memberHeaders(api)) },
    data: {
      mutations: mutations.map((m) => ({ mid: crypto.randomUUID(), at: Date.now(), ...m })),
    },
  })
  expect(res.ok()).toBe(true)
}

/** The sign-in code mailed to `email`, once it has been sent. */
async function mailedCode(api: APIRequestContext, email: string): Promise<string> {
  let code = ''
  await expect
    .poll(async () => {
      code = await latestCode(api, email).catch(() => '')
      return code
    })
    .not.toBe('')
  return code
}

test.beforeAll(async () => {
  const owner = await request.newContext({
    baseURL: BASE,
    extraHTTPHeaders: { 'cf-connecting-ip': '198.51.100.20' },
  })
  try {
    await signInRequest(owner, EXAMPLE)
    const named = await owner.put(`${BASE}/api/v1/profile`, {
      headers: { ...ORIGIN, ...(await memberHeaders(owner)) },
      data: { handle: 'hutusi', displayName: NAME, bio: BIO },
    })
    expect(named.ok()).toBe(true)
    // A blog they read, already in Tela from the setup: subscribing is enough.
    const added = await owner.post(`${BASE}/api/v1/feeds`, {
      headers: { ...ORIGIN, ...(await memberHeaders(owner)) },
      data: { feedUrl: `${FIXTURES}/jvns.xml` },
    })
    expect(added.ok()).toBe(true)
    const pulled = (await (
      await owner.get(`${BASE}/api/v1/sync?cursor=0`, { headers: await memberHeaders(owner) })
    ).json()) as { rows: { articles: { id: number }[] } }
    const first = pulled.rows.articles[0]
    if (!first) throw new Error('the fixture feed has no posts')
    await push(owner, [
      { type: 'recommend', articleId: first.id, note: NOTE },
      { type: 'setPrivacy', publicSubscriptions: true },
    ])
  } finally {
    await owner.dispose()
  }
})

test.describe('For writers, for a visitor', () => {
  test.use(visitor(21))

  test("shows @hutusi's live card, and the notes from it", async ({ page }) => {
    await page.goto('/writers')
    // The active pill: its own ground, not only on hover.
    await expect(page.getByTestId('nav-writers')).toHaveClass(/(^|\s)bg-hover(\s|$)/)
    const card = page.getByTestId('writer-card')
    await expect(card).toHaveAttribute('data-card', 'example')
    await expect(card.getByTestId('writer-card-name')).toHaveText(NAME)
    await expect(card.getByTestId('writer-card-handle')).toHaveText('@hutusi')
    await expect(card.getByTestId('writer-card-bio')).toHaveText(BIO)
    await expect(card.getByTestId('writer-card-reads')).toContainText(/Reads \d+ blogs?/)
    // The latest recommendation stands where a pinned post would: Tela has none.
    await expect(card.getByTestId('writer-card-latest')).toContainText(NOTE)
    await expect(page.getByTestId('writers-note').first()).toContainText(NOTE)

    // The closing call goes back to the form, ready to type in.
    await page.getByTestId('writers-make').click()
    await expect(page.getByTestId('writers-name')).toBeFocused()
  })

  test('checks the handle as the visitor types, and offers another when it is taken', async ({
    page,
  }) => {
    await page.goto('/writers')
    await page.getByTestId('writers-blog').fill('hutusi.e2e.test')
    await page.getByTestId('writers-name').fill('Hutusi Again')
    const card = page.getByTestId('writer-card')
    await expect(card).toHaveAttribute('data-card', 'draft')
    await expect(card.getByTestId('writer-card-name')).toHaveText('Hutusi Again')
    await expect(card.getByTestId('writer-card-handle')).toHaveText('@hutusi')
    await expect(card.getByTestId('writer-card-blog')).toHaveText('hutusi.e2e.test')
    await expect(card.getByTestId('writer-card-later')).toBeVisible()

    const said = page.getByTestId('writers-availability')
    await expect(said).toHaveAttribute('data-status', 'taken')
    await expect(said).toContainText('@hutusi is taken.')
    const suggestion = said.getByTestId('writers-suggestion')
    const offered = ((await suggestion.textContent()) ?? '').trim()
    expect(offered).toMatch(/^@[a-z0-9_]{3,30}$/)
    await suggestion.click()
    await expect(card.getByTestId('writer-card-handle')).toHaveText(offered)
    await expect(said).toHaveAttribute('data-status', 'available')
    await expect(said).toContainText(`✓ ${offered} is available`)
  })

  test('keeps both pills whole in the 360px header', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 800 })
    await page.goto('/writers')
    await page.getByTestId('nav-writers').waitFor()
    const m = await measureHeader(page, ['nav-join'])
    expectHeaderFits(m, 360)
    expect(m.client, 'nav is clipped').toBe(m.scroll)
  })
})

test.describe('Claim your card', () => {
  test.use(visitor(22))

  test('joins through the sheet, sets the handle and name, and starts the claim from the blog', async ({
    page,
    request,
  }) => {
    const code = await adminCode(request)
    const stamp = Date.now().toString(36)
    const first = `Zofia${stamp}`
    const name = `${first} Nowak`
    const handle = first.toLowerCase()
    const email = `writer-${stamp}@e2e.test`

    await page.goto('/writers')
    await page.getByTestId('writers-blog').fill(`${handle}.e2e.test`)
    await page.getByTestId('writers-name').fill(name)
    await expect(page.getByTestId('writers-availability')).toHaveAttribute(
      'data-status',
      'available',
    )
    await page.getByTestId('writers-claim').click()

    const sheet = page.getByTestId('front-door')
    await expect(sheet).toBeVisible()
    await expect(sheet.getByRole('heading')).toHaveText(`Claim @${handle}`)
    await expect(sheet.getByTestId('join-code')).toBeFocused()
    await sheet.getByTestId('join-code').fill(code)
    await sheet.getByTestId('login-email').fill(email)
    await sheet.getByTestId('login-submit').click()
    await expect(sheet.getByTestId('login-code')).toBeVisible()
    await sheet.getByTestId('login-code').fill(await mailedCode(request, email))
    await sheet.getByTestId('login-submit').click()

    const blog = `https://${handle}.e2e.test`
    await expect(page).toHaveURL(`/claim?url=${encodeURIComponent(blog)}`)
    await expect(sheet).toHaveCount(0)
    await expect(page.getByTestId('claim-url')).toHaveValue(blog)
    await expect(page.getByTestId('claim-taken')).toHaveCount(0)

    // The card is the new member's: their handle and name, not the provisional ones.
    const me = (await (await page.request.get(`${BASE}/api/v1/me`)).json()) as {
      profile: { handle: string; displayName: string | null }
    }
    expect(me.profile.handle).toBe(handle)
    expect(me.profile.displayName).toBe(name)
  })
})

test.describe('For writers, for a member', () => {
  test('offers their card and the claim instead of the form', async ({ page }) => {
    await page.goto('/writers')
    await expect(page.getByTestId('writers-member')).toBeVisible()
    await expect(page.getByTestId('writers-form')).toHaveCount(0)
    await expect(page.getByTestId('writers-claim-blog')).toHaveAttribute('href', '/claim')
    const me = (await (await page.request.get(`${BASE}/api/v1/me`)).json()) as {
      profile: { handle: string }
    }
    await expect(page.getByTestId('writers-your-card')).toHaveAttribute(
      'href',
      `/@${me.profile.handle}`,
    )
  })
})

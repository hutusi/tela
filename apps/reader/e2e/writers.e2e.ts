/**
 * For writers: beside the form is a sample card, labelled as one, and the sections under it draw
 * from the same sample, with nothing in any of them a link (ADR 0037). The handle is checked as the
 * visitor types (`@hutusi` is taken here, by a member made for it), and "Claim your card" carries
 * the card through the sheet: the new member's handle and name are set, and the claim starts from
 * the blog they gave. A member gets the ways on instead of the form. Each signing-in context comes
 * from its own address, since better-auth and `/api/v1/join` count tries per IP.
 */
import { type APIRequestContext, expect, request, test } from '@playwright/test'
import {
  adminCode,
  BASE,
  expectHeaderFits,
  latestCode,
  measureHeader,
  memberHeaders,
  signInRequest,
} from './helpers'

const ORIGIN = { origin: BASE }
const visitor = (n: number) => ({
  storageState: { cookies: [], origins: [] },
  extraHTTPHeaders: { 'cf-connecting-ip': `198.51.100.${n}` },
})

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

// A member who holds `@hutusi`, so that typing that name finds it taken.
test.beforeAll(async () => {
  const owner = await request.newContext({
    baseURL: BASE,
    extraHTTPHeaders: { 'cf-connecting-ip': '198.51.100.20' },
  })
  try {
    await signInRequest(owner, 'hutusi@e2e.test')
    const named = await owner.put(`${BASE}/api/v1/profile`, {
      headers: { ...ORIGIN, ...(await memberHeaders(owner)) },
      data: { handle: 'hutusi', displayName: 'Hu Tusi' },
    })
    expect(named.ok()).toBe(true)
  } finally {
    await owner.dispose()
  }
})

test.describe('For writers, for a visitor', () => {
  test.use(visitor(21))

  test('shows a sample card, says it is one, and links nowhere from it', async ({ page }) => {
    await page.goto('/writers')
    // The active pill: its own ground, not only on hover.
    await expect(page.getByTestId('nav-writers')).toHaveClass(/(^|\s)bg-hover(\s|$)/)
    const card = page.getByTestId('writer-card')
    await expect(card).toHaveAttribute('data-card', 'sample')
    await expect(card.getByTestId('writer-card-name')).toHaveText('Lucía Ferrer')
    await expect(card.getByTestId('writer-card-handle')).toHaveText('@lucia')
    await expect(card.getByTestId('writer-card-reads')).toHaveText('Reads 24 blogs')
    await expect(card.getByTestId('writer-card-latest')).toContainText(
      'A kitchen you can take with you',
    )
    await expect(page.getByTestId('writer-card-caption')).toHaveText(
      'An example card. Type your name to see yours.',
    )

    // Following, for example: four rows of the kinds Following has, newest first.
    const find = page.getByTestId('writers-find')
    await expect(find).toContainText('Following · for example')
    await expect(find.getByTestId('writers-activity')).toHaveCount(4)
    await expect(find.getByTestId('writers-activity').first()).toContainText('12m ago')
    await expect(find.getByTestId('writers-note')).toHaveCount(2)
    await expect(page.getByTestId('writers-roll').locator('li')).toHaveCount(4)
    await expect(page.getByTestId('writers-readers')).toContainText('61 readers on Tela')

    // None of it is anyone's: no link to a profile, a post or a blog that is not there.
    for (const id of ['writer-card', 'writers-find', 'writers-roll', 'writers-readers']) {
      await expect(page.getByTestId(id).locator('a')).toHaveCount(0)
    }
    await expect(page.getByTestId('writers-link-pill')).not.toHaveAttribute('href', /.*/)

    // The closing call goes back to the form, ready to type in.
    await page.getByTestId('writers-make').click()
    await expect(page.getByTestId('writers-name')).toBeFocused()
  })

  test("reads the sample's titles in Chinese, and its bio as written", async ({
    page,
    context,
  }) => {
    await context.addCookies([{ name: 'tela_locale', value: 'zh-Hans', url: BASE }])
    await page.goto('/writers')
    const card = page.getByTestId('writer-card')
    await expect(card.getByTestId('writer-card-latest')).toContainText('一间可以带着走的厨房')
    await expect(card.getByTestId('writer-card-bio')).toHaveText(
      'Walking notes from Madrid, mostly written before breakfast.',
    )
    await expect(page.getByTestId('writer-card-caption')).toHaveText(
      '一张示例名片。输入你的名字，看看你的。',
    )
    await expect(page.getByTestId('writers-find')).toContainText('清晨六点，格兰大道上能听到什么')
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

  test('cuts a long handle before the Follow pill on a 360px card', async ({ page }) => {
    // A valid handle of 26 characters with nowhere to break ran some 60px under the pill (Codex
    // review, PR #25). Typed, the draft card takes the handle from the name.
    await page.setViewportSize({ width: 360, height: 800 })
    await page.goto('/writers')
    await page.getByTestId('writers-name').fill('Alexanderthegreatofmacedon')
    const card = page.getByTestId('writer-card')
    await expect(card).toHaveAttribute('data-card', 'draft')
    const handle = card.getByTestId('writer-card-handle')
    await expect(handle).toContainText('@alexanderthegreat')
    // Where the handle is painted, not where its box is: a box held to its column says nothing
    // about text that spills out of it. The text's own extent counts, cut at the box only when the
    // box clips what overflows it.
    const painted = await handle.evaluate((el) => {
      const range = document.createRange()
      range.selectNodeContents(el)
      const text = range.getBoundingClientRect().right
      const clips = getComputedStyle(el).overflowX !== 'visible'
      return clips ? Math.min(text, el.getBoundingClientRect().right) : text
    })
    const pill = await card.getByTestId('writer-card-follow').boundingBox()
    expect(pill, 'the pill is laid out').toBeTruthy()
    expect(painted, 'the handle is painted before the pill').toBeLessThanOrEqual(pill?.x ?? 0)
    await expect(handle).toHaveAttribute('title', '@alexanderthegreatofmacedon')
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
    await expect(page.getByTestId('writer-card-caption')).toHaveText('An example card.')
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

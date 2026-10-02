/**
 * Settings in sections the URL names (Tela v2): the nav, the privacy switches that act at once,
 * subscriptions left and taken back where they were left, and "Your data" as one file.
 */
import { readFile } from 'node:fs/promises'
import { type APIRequestContext, expect, type Page, test } from '@playwright/test'
import {
  BASE,
  FIXTURES,
  keepCycling,
  memberHeaders,
  pngFile,
  STATE_FILE,
  setPrefs,
  synced,
} from './helpers'

/** The member's profile row as the server has it, through a snapshot pull. */
async function serverProfile(request: APIRequestContext) {
  const res = await request.get(`${BASE}/api/v1/sync?cursor=0`, {
    headers: await memberHeaders(request),
  })
  const body = (await res.json()) as {
    rows: { profile: { publicLikes: boolean; publicSubscriptions: boolean }[] }
  }
  return body.rows.profile[0]
}

/** Both privacy flags off, as a new member has them. */
async function hideEverything(request: APIRequestContext) {
  const res = await request.post(`${BASE}/api/v1/mutations`, {
    headers: { origin: BASE, ...(await memberHeaders(request)) },
    data: {
      mutations: [
        {
          mid: crypto.randomUUID(),
          at: Date.now(),
          type: 'setPrivacy',
          publicLikes: false,
          publicSubscriptions: false,
        },
      ],
    },
  })
  expect(res.ok()).toBe(true)
}

test.describe('settings', () => {
  test('each section has its address: the nav moves between them, and Back returns', async ({
    page,
  }) => {
    await page.goto('/settings')
    await expect(page.getByTestId('settings-content')).toHaveAttribute('data-section', 'profile')
    await expect(page.getByTestId('settings-form')).toBeVisible()
    await page.getByTestId('settings-section-reading').click()
    await expect(page).toHaveURL(/\/settings\/reading$/)
    await expect(page.getByTestId('theme-system')).toBeVisible()
    await page.getByTestId('settings-section-privacy').click()
    await expect(page).toHaveURL(/\/settings\/privacy$/)
    await page.goBack()
    await expect(page.getByTestId('settings-content')).toHaveAttribute('data-section', 'reading')
    await expect(page.getByTestId('settings-section-reading')).toHaveAttribute(
      'aria-current',
      'page',
    )
    // An address that names no section is the first one.
    await page.goto('/settings/nothing-here')
    await expect(page).toHaveURL(/\/settings$/)
  })

  test('the privacy switches act at once, and the server has them', async ({ page, request }) => {
    await hideEverything(request)
    await page.goto('/settings/privacy')
    const likes = page.getByTestId('privacy-likes')
    await expect(likes).toHaveAttribute('aria-checked', 'false')
    const pushed = page.waitForResponse((r) => r.url().includes('/api/v1/mutations') && r.ok())
    await likes.click()
    await expect(likes).toHaveAttribute('aria-checked', 'true')
    await pushed
    expect(await serverProfile(request)).toMatchObject({
      publicLikes: true,
      publicSubscriptions: false,
    })
    // Off again, so no other spec meets a profile showing likes it did not ask for.
    const again = page.waitForResponse((r) => r.url().includes('/api/v1/mutations') && r.ok())
    await likes.click()
    await again
    expect(await serverProfile(request)).toMatchObject({ publicLikes: false })
  })

  test('a blog left from the list stays there, dimmed, to take back', async ({ page }) => {
    await page.goto('/settings/subscriptions')
    const rows = page.getByTestId('settings-subscription')
    await expect(rows.first()).toBeVisible()
    const count = await rows.count()
    const row = rows.filter({ hasText: 'Julia Evans' })
    const toggle = row.getByTestId('settings-subscription-toggle')
    // The button names what it does, not a pressed state ("Unsubscribe, pressed" read backwards).
    await expect(toggle).toHaveText('Unsubscribe')
    await expect(toggle).not.toHaveAttribute('aria-pressed')
    await toggle.click()
    await expect(toggle).toHaveText('Subscribe')
    await expect(rows).toHaveCount(count)
    await expect(page.getByTestId('subscription-count')).toContainText(`${count - 1} blog`)
    const back = page.waitForResponse((r) => r.url().includes('/api/v1/mutations') && r.ok())
    await toggle.click()
    await expect(toggle).toHaveText('Unsubscribe')
    await expect(page.getByTestId('subscription-count')).toContainText(`${count} blog`)
    await back
  })

  test('"Your data" is one file holding the subscriptions', async ({ page }) => {
    await page.goto('/settings/privacy')
    const saved = page.waitForEvent('download')
    await page.getByTestId('data-export').click()
    const download = await saved
    expect(download.suggestedFilename()).toMatch(/^tela-.+\.json$/)
    const body = JSON.parse(await readFile(await download.path(), 'utf8')) as {
      subscriptions: { feedUrl: string }[]
    }
    expect(body.subscriptions.map((s) => s.feedUrl)).toContain(`${FIXTURES}/jvns.xml`)
  })

  test('a never-translated language is chosen, then added', async ({ page }) => {
    await page.goto('/settings/translation')
    const chips = page.getByTestId('never-chip')
    const before = await chips.count()
    // Choosing is not adding: arrow keys and type-ahead on a select fire a change per step.
    await page.getByTestId('never-add').selectOption('ja')
    await expect(chips).toHaveCount(before)
    // From the keyboard: Add removes itself, and focus stays in the control rather than the page.
    await page.getByTestId('never-add-confirm').focus()
    await page.keyboard.press('Enter')
    await expect(chips).toHaveCount(before + 1)
    await expect(page.getByTestId('never-add-confirm')).toHaveCount(0)
    await expect(page.getByTestId('never-add')).toBeFocused()
    // Taken back, so no other spec meets a language it did not ask to read as written.
    const pushed = page.waitForResponse((r) => r.url().includes('/api/v1/mutations') && r.ok())
    await page.getByTestId('never-remove-ja').focus()
    await page.keyboard.press('Enter')
    await expect(chips).toHaveCount(before)
    await expect(page.getByTestId('never-add')).toBeFocused()
    await pushed
  })

  test('the bio counts what is left of it', async ({ page }) => {
    await page.goto('/settings')
    const bio = page.locator('textarea[name="bio"]')
    await bio.fill('Hello')
    await expect(page.getByTestId('settings-form')).toContainText('275 characters left')
  })
})

test.describe('the interface language', () => {
  test('chosen before the first sync lands, is kept and saved', async ({ browser, request }) => {
    // The account says English; this device has never synced.
    await setPrefs(request, {}, { uiLocale: 'en' })
    const fresh = await browser.newContext({ storageState: STATE_FILE })
    try {
      const page = await fresh.newPage()
      let release = () => {}
      const held = new Promise<void>((resolve) => {
        release = resolve
      })
      await page.route('**/api/v1/sync**', async (route) => {
        await held
        await route.continue()
      })
      await page.goto('/settings/translation')
      const pushed = page.waitForResponse((r) => r.url().includes('/api/v1/mutations') && r.ok())
      await page.getByTestId('ui-locale-zh-Hans').click()
      await expect(page.locator('html')).toHaveAttribute('lang', 'zh-Hans')
      // Now the profile arrives, with the account's older English, and the choice stands.
      release()
      await pushed
      await page.goto('/reading')
      await synced(page)
      await expect(page.locator('html')).toHaveAttribute('lang', 'zh-Hans')
      const snapshot = await request.get(`${BASE}/api/v1/sync?cursor=0`, {
        headers: await memberHeaders(request),
      })
      const body = (await snapshot.json()) as { rows: { profile: { uiLocale: string }[] } }
      expect(body.rows.profile[0]?.uiLocale).toBe('zh-Hans')
    } finally {
      await fresh.close()
      await setPrefs(request, {}, { uiLocale: 'en' })
    }
  })

  test('follows the member to a device that was in English', async ({ page, browser, request }) => {
    try {
      await page.goto('/settings/translation')
      const pushed = page.waitForResponse((r) => r.url().includes('/api/v1/mutations') && r.ok())
      await page.getByTestId('ui-locale-zh-Hans').click()
      await pushed

      // Another device: the same member, and a cookie that still says English.
      const other = await browser.newContext({ storageState: STATE_FILE })
      try {
        await other.addCookies([{ name: 'tela_locale', value: 'en', url: BASE }])
        const there = await other.newPage()
        await there.goto('/reading')
        await synced(there)
        await expect(there.locator('html')).toHaveAttribute('lang', 'zh-Hans')
        await expect(there.getByTestId('nav-reading')).toHaveText('阅读')
        // And the cookie follows, so the edge renders the next public page in Chinese too.
        const cookies = await other.cookies(BASE)
        expect(cookies.find((c) => c.name === 'tela_locale')?.value).toBe('zh-Hans')
      } finally {
        await other.close()
      }
    } finally {
      // Every spec signs in as this member: none should inherit Chinese from this one.
      await setPrefs(request, {}, { uiLocale: 'en' })
    }
  })
})

test.describe("the member's picture (ADR 0032, 0033)", () => {
  /** The switch, through the API, as the page's own push sends it. */
  async function setGravatar(request: APIRequestContext, on: boolean) {
    const res = await request.post(`${BASE}/api/v1/mutations`, {
      headers: { origin: BASE, ...(await memberHeaders(request)) },
      data: {
        mutations: [{ mid: crypto.randomUUID(), at: Date.now(), type: 'setAvatar', gravatar: on }],
      },
    })
    expect(res.ok()).toBe(true)
  }
  /** Whether the fixture standing in for gravatar.com has a picture for every address. */
  const gravatars = async (request: APIRequestContext, on: boolean) => {
    const res = await request.post(`${FIXTURES}/__gravatar?on=${on ? 1 : 0}`)
    expect(res.ok()).toBe(true)
  }
  const pushed = (page: Page) =>
    page.waitForResponse((r) => r.url().includes('/api/v1/mutations') && r.ok())
  /** The hint once the check has answered: the page pulls on `online`, as after a reconnect. */
  const hintBecomes = async (page: Page, hint: string) =>
    expect
      .poll(
        async () => {
          await page.evaluate(() => window.dispatchEvent(new Event('online')))
          return page.getByTestId('profile-gravatar-row').getAttribute('data-hint')
        },
        { timeout: 30_000 },
      )
      .toBe(hint)

  test('is their Gravatar by default, once Gravatar has one; off, their letter', async ({
    page,
    request,
  }) => {
    const stop = keepCycling(page)
    try {
      await gravatars(request, false)
      await page.goto('/settings')
      const picture = page.getByTestId('account-menu').locator('img')
      // On by default; Refresh asks Gravatar now, and it has nothing: the letter, and why.
      let push = pushed(page)
      await page.getByTestId('profile-gravatar-refresh').click()
      await push
      await hintBecomes(page, 'none')
      await expect(picture).toHaveCount(0)

      // Gravatar has one now; asked again, it shows, from Tela's own address, and loads.
      await gravatars(request, true)
      push = pushed(page)
      await page.getByTestId('profile-gravatar-refresh').click()
      await push
      await hintBecomes(page, 'shown')
      await expect(picture).toHaveAttribute('src', /^\/avatar\/[A-Za-z0-9_-]+\?v=\d+$/)
      await expect
        .poll(() => picture.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth))
        .toBeGreaterThan(0)

      // Off: the letter, at once.
      push = pushed(page)
      await page.getByTestId('profile-gravatar').click()
      await push
      await expect(picture).toHaveCount(0)
      await expect(page.getByTestId('profile-gravatar-row')).toHaveAttribute('data-hint', 'off')
    } finally {
      stop()
      // Every spec signs in as this member: the next one starts from the letter.
      await gravatars(request, false)
      await setGravatar(request, true)
    }
  })

  test('an upload, cropped in the dialog, comes first; removed, it is gone', async ({ page }) => {
    await page.goto('/settings')
    const picture = page.getByTestId('account-menu').locator('img')
    await page.getByTestId('profile-picture-input').setInputFiles({
      name: 'me.png',
      mimeType: 'image/png',
      buffer: pngFile(600, 400),
    })
    const dialog = page.getByTestId('avatar-crop')
    await expect(dialog).toBeVisible()
    // Move it, then zoom all the way in, with the keyboard as well as the pointer.
    const frame = page.getByTestId('avatar-crop-frame')
    const box = await frame.boundingBox()
    if (!box) throw new Error('no crop frame')
    await page.mouse.move(box.x + 140, box.y + 140)
    await page.mouse.down()
    await page.mouse.move(box.x + 90, box.y + 140, { steps: 5 })
    await page.mouse.up()
    await page.getByTestId('avatar-crop-zoom').focus()
    await page.keyboard.press('End')
    await frame.focus()
    await page.keyboard.press('ArrowLeft')

    const saved = page.waitForResponse(
      (r) => r.url().endsWith('/api/v1/avatar') && r.request().method() === 'PUT',
    )
    await page.getByTestId('avatar-crop-save').click()
    const res = await saved
    expect(res.status()).toBe(200)
    // What the canvas drew, not the file chosen: a 256 px square, WebP in Chromium.
    expect(res.request().headers()['content-type']).toBe('image/webp')
    await expect(dialog).toHaveCount(0)
    await expect(picture).toHaveAttribute('src', /^\/avatar\/[A-Za-z0-9_-]+\?v=\d+$/)
    await expect
      .poll(() =>
        picture.evaluate((img: HTMLImageElement) => (img.complete ? img.naturalWidth : 0)),
      )
      .toBe(256)
    await expect(page.getByTestId('profile-picture-upload')).toHaveText('Change picture')

    const removed = page.waitForResponse(
      (r) => r.url().endsWith('/api/v1/avatar') && r.request().method() === 'DELETE',
    )
    await page.getByTestId('profile-picture-remove').click()
    expect((await removed).status()).toBe(200)
    await expect(picture).toHaveCount(0)
    await expect(page.getByTestId('profile-picture-remove')).toHaveCount(0)
  })

  test('the crop dialog cancels with Esc, and keeps nothing', async ({ page }) => {
    await page.goto('/settings')
    await page.getByTestId('profile-picture-input').setInputFiles({
      name: 'me.png',
      mimeType: 'image/png',
      buffer: pngFile(300, 300),
    })
    await expect(page.getByTestId('avatar-crop')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('avatar-crop')).toHaveCount(0)
    await expect(page.getByTestId('profile-picture-remove')).toHaveCount(0)
  })
})

/**
 * Settings in sections the URL names (Tela v2): the nav, the privacy switches that act at once,
 * subscriptions left and taken back where they were left, and "Your data" as one file.
 */
import { readFile } from 'node:fs/promises'
import { type APIRequestContext, expect, test } from '@playwright/test'
import { BASE, FIXTURES, memberHeaders, STATE_FILE, setPrefs, synced } from './helpers'

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

/**
 * The front door for a visitor (ADRs 0034, 0035, 0036): the header they get, at every width and in
 * both themes, and the sheet its Log in and Join open, by code, by password and with an invite
 * code. Signed out from the start. Each test that signs in or joins comes from its own address,
 * since better-auth and `/api/v1/join` count tries per IP; in production Cloudflare sets the
 * header itself.
 */
import { type APIRequestContext, expect, type Page, type Route, test } from '@playwright/test'
import {
  adminCode,
  BASE,
  expectHeaderFits,
  inviteAndReadCode,
  joinAndReadCode,
  latestCode,
  measureHeader,
  STATE_FILE,
  signInRequest,
} from './helpers'

test.use({ storageState: { cookies: [], origins: [] } })

const visitor = (n: number) => ({ extraHTTPHeaders: { 'cf-connecting-ip': `198.51.100.${n}` } })

/** A write through tela-web must come from its origin, as a browser's would. */
const ORIGIN = { origin: BASE }

/** How many mails the outbox holds for `email`. */
async function mails(request: APIRequestContext, email: string): Promise<number> {
  const res = await request.get(`${BASE}/api/test/outbox?email=${encodeURIComponent(email)}`)
  return ((await res.json()) as unknown[]).length
}

/** The code of the mail after the first `before` of them, once it has been sent. */
async function codeAfter(request: APIRequestContext, email: string, before: number) {
  await expect.poll(() => mails(request, email)).toBeGreaterThan(before)
  return latestCode(request, email)
}

test.describe('the visitor header', () => {
  /**
   * The member's header is measured in styles.e2e.ts; a visitor's has controls of its own (Read
   * in, Log in, Join), and the width budget is the gotcha that hid a 4px nav from 768 to 1100px.
   * Below `sm` only Join stays beside the nav.
   */
  for (const width of [360, 412, 640, 768, 800, 1024, 1280]) {
    test(`fits, and keeps its nav whole, at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 })
      // The front page, where a visitor arrives: the page under the header must fit too.
      await page.goto('/')
      await page.getByTestId('nav-join').waitFor()
      const wide = width >= 640
      const controls = wide ? ['nav-join', 'nav-login', 'visitor-locale'] : ['nav-join']
      const m = await measureHeader(page, controls)
      expectHeaderFits(m, width)
      // A visitor's nav is short enough never to scroll.
      expect(m.client, 'nav is clipped').toBe(m.scroll)
      // Each on one line: squeezed, a label wraps into the 56px bar instead.
      for (const id of controls) {
        expect(m.controls[id]?.height, `${id} wrapped`).toBeLessThanOrEqual(36)
      }
      if (!wide) {
        await expect(page.getByTestId('nav-login')).toBeHidden()
        await expect(page.getByTestId('visitor-locale')).toBeHidden()
      }
      // Reading and search are a member's.
      await expect(page.getByTestId('nav-reading')).toHaveCount(0)
      await expect(page.getByTestId('search-link')).toHaveCount(0)
    })
  }

  test('Join and the sheet are the primary pair: ink by day, the lifted green by night', async ({
    page,
  }) => {
    const pair = (testId: string) =>
      page.getByTestId(testId).evaluate((el) => {
        const style = getComputedStyle(el)
        return { ground: style.backgroundColor, text: style.color }
      })
    // Whatever this Chromium serializes oklch() as, compared with itself.
    const green = () =>
      page.evaluate(() => {
        const probe = document.createElement('div')
        probe.style.color = 'oklch(0.68 0.14 150)'
        document.body.append(probe)
        const value = getComputedStyle(probe).color
        probe.remove()
        return value
      })
    const day = { ground: 'rgb(31, 28, 24)', text: 'rgb(246, 242, 234)' }

    await page.emulateMedia({ colorScheme: 'light' })
    await page.goto('/discover')
    expect(await pair('nav-join')).toEqual(day)
    await page.getByTestId('nav-join').click()
    expect(await pair('login-submit')).toEqual(day)

    // A literal colour in a class list would stay as it was on the dark ground.
    await page.emulateMedia({ colorScheme: 'dark' })
    const night = { ground: await green(), text: 'rgb(22, 20, 15)' }
    expect(await pair('login-submit')).toEqual(night)
    await page.keyboard.press('Escape')
    expect(await pair('nav-join')).toEqual(night)
  })
})

test.describe('the Log in sheet, by code', () => {
  test.use(visitor(11))
  test('opens over the page, closes with Esc, and signs a member in with their code', async ({
    page,
    request,
  }) => {
    const email = `sheet-code-${Date.now()}@e2e.test`
    await inviteAndReadCode(request, email)

    await page.goto('/discover')
    await page.getByTestId('nav-login').click()
    const sheet = page.getByTestId('front-door')
    await expect(sheet).toBeVisible()
    // Over the page: the address is still the page's.
    await expect(page).toHaveURL(/\/discover$/)
    await expect(sheet.getByTestId('login-email')).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(sheet).toHaveCount(0)
    await expect(page).toHaveURL(/\/discover$/)

    await page.getByTestId('nav-login').click()
    const before = await mails(request, email)
    await sheet.getByTestId('login-email').fill(email)
    await sheet.getByTestId('login-submit').click()
    // The new step takes the focus: the field that held it is gone.
    await expect(sheet.getByTestId('login-code')).toBeFocused()
    await sheet.getByTestId('login-code').fill(await codeAfter(request, email, before))
    await sheet.getByTestId('login-submit').click()
    await expect(page).toHaveURL(/\/reading$/)
    await expect(sheet).toHaveCount(0)
    await expect(page.getByTestId('account-menu')).toBeVisible()
  })
})

test.describe('the Log in sheet, by password', () => {
  test.use(visitor(12))
  test('a member logs in with their password, and a wrong one is told so', async ({
    page,
    request,
  }) => {
    const email = `sheet-password-${Date.now()}@e2e.test`
    const password = `correct horse ${Date.now()}`
    await signInRequest(request, email)
    // A password, as a reset code sets one for a member without.
    const before = await mails(request, email)
    const asked = await request.post(`${BASE}/api/auth/email-otp/request-password-reset`, {
      headers: ORIGIN,
      data: { email },
    })
    expect(asked.ok()).toBe(true)
    const otp = await codeAfter(request, email, before)
    const reset = await request.post(`${BASE}/api/auth/email-otp/reset-password`, {
      headers: ORIGIN,
      data: { email, otp, password },
    })
    expect(reset.ok()).toBe(true)

    await page.goto('/discover')
    await page.getByTestId('nav-login').click()
    const sheet = page.getByTestId('front-door')
    await sheet.getByTestId('login-mode').click()
    await sheet.getByTestId('login-email').fill(email)
    await sheet.getByTestId('login-password').fill('not the password at all')
    await sheet.getByTestId('login-submit').click()
    await expect(sheet.getByTestId('door-error')).toHaveText(
      'That email and password do not match.',
    )
    await sheet.getByTestId('login-password').fill(password)
    await sheet.getByTestId('login-submit').click()
    await expect(page).toHaveURL(/\/reading$/)
    await expect(page.getByTestId('account-menu')).toBeVisible()
  })
})

test.describe('Join, with an invite code', () => {
  test.use(visitor(13))
  test('makes the account, keeps the password chosen at the code step, and lands on Discover', async ({
    page,
    request,
  }) => {
    const code = await adminCode(request)
    const email = `joiner-${Date.now()}@e2e.test`
    const password = `joined on ${Date.now()}`

    await page.goto('/discover')
    await page.getByTestId('nav-join').click()
    const sheet = page.getByTestId('front-door')
    await expect(sheet.getByTestId('join-code')).toBeFocused()
    // Terms and Privacy open beside the sheet, which keeps the code typed into it.
    for (const id of ['door-terms', 'door-privacy']) {
      await expect(sheet.getByTestId(id)).toHaveAttribute('target', '_blank')
    }
    // A code nobody made: no mail, and the sheet says so.
    await sheet.getByTestId('join-code').fill('NOSUCHCODE')
    await sheet.getByTestId('login-email').fill(email)
    await sheet.getByTestId('login-submit').click()
    await expect(sheet.getByTestId('door-error')).toHaveText(
      'There is no such invite code, or it was withdrawn.',
    )
    expect(await mails(request, email)).toBe(0)

    // Typed in any case, it is the same code.
    await sheet.getByTestId('join-code').fill(code.toLowerCase())
    await sheet.getByTestId('login-submit').click()
    await expect(sheet.getByTestId('login-code')).toBeVisible()
    await sheet.getByTestId('login-code').fill(await codeAfter(request, email, 0))
    await sheet.getByTestId('join-password').fill(password)
    await sheet.getByTestId('login-submit').click()
    await expect(page).toHaveURL(/\/discover$/)
    await expect(sheet).toHaveCount(0)
    await expect(page.getByTestId('account-menu')).toBeVisible()

    // The password is the member's now, from any browser.
    const signedIn = await request.post(`${BASE}/api/auth/sign-in/email`, {
      headers: ORIGIN,
      data: { email, password },
    })
    expect(signedIn.ok()).toBe(true)
  })
})

test.describe('Join, from the front page', () => {
  test.use(visitor(15))
  test("the front page's own Join opens the sheet, and the new member lands on Discover", async ({
    page,
    request,
  }) => {
    const code = await adminCode(request)
    const email = `front-joiner-${Date.now()}@e2e.test`
    await page.goto('/')
    await page.getByTestId('front-join').click()
    const sheet = page.getByTestId('front-door')
    await expect(sheet.getByTestId('join-code')).toBeFocused()
    await sheet.getByTestId('join-code').fill(code)
    await sheet.getByTestId('login-email').fill(email)
    await sheet.getByTestId('login-submit').click()
    await expect(sheet.getByTestId('login-code')).toBeFocused()
    await sheet.getByTestId('login-code').fill(await codeAfter(request, email, 0))
    await sheet.getByTestId('login-submit').click()
    // Not the reading the front page sends a member to: a newcomer has nothing to read yet.
    await expect(page).toHaveURL(/\/discover$/)
    await expect(sheet).toHaveCount(0)
    await expect(page.getByTestId('account-menu')).toBeVisible()
  })
})

test.describe('Join, while the chosen password saves', () => {
  /**
   * `/` and `/join` send a member to their reading, and the joiner is one before the password they
   * chose is saved. Until the sheet has finished, it says where they go: the save, held back here
   * and then answered by `answer`, is still its own. Returns every path the page was at.
   */
  async function join(
    page: Page,
    request: APIRequestContext,
    from: 'front' | 'link',
    answer: (route: Route) => Promise<void>,
  ) {
    const visited: string[] = []
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) visited.push(new URL(frame.url()).pathname)
    })
    await page.route('**/api/v1/account/password', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1500))
      await answer(route)
    })
    const code = await adminCode(request)
    const email = `slow-save-${from}-${Date.now()}@e2e.test`
    const sheet = page.getByTestId('front-door')
    if (from === 'front') {
      await page.goto('/')
      await page.getByTestId('front-join').click()
      await sheet.getByTestId('join-code').fill(code)
    } else {
      await page.goto(`/join?code=${code}`)
      await expect(sheet.getByTestId('join-code')).toHaveValue(code)
    }
    await sheet.getByTestId('login-email').fill(email)
    await sheet.getByTestId('login-submit').click()
    await sheet.getByTestId('login-code').fill(await codeAfter(request, email, 0))
    await sheet.getByTestId('join-password').fill(`chosen on ${Date.now()}`)
    await sheet.getByTestId('login-submit').click()
    return { sheet, visited }
  }

  test.describe('refused', () => {
    test.use(visitor(41))
    test('the sheet says so over the front page, and Continue goes on to Discover', async ({
      page,
      request,
    }) => {
      const { sheet, visited } = await join(page, request, 'front', (route) =>
        route.fulfill({ status: 503, body: 'unavailable' }),
      )
      await expect(sheet.getByTestId('door-unsaved')).toBeVisible()
      await expect(page).toHaveURL(`${BASE}/`)
      await sheet.getByTestId('login-submit').click()
      await expect(page).toHaveURL(/\/discover$/)
      await expect(sheet).toHaveCount(0)
      expect(visited).not.toContain('/reading')
    })
  })

  test.describe('refused, then closed', () => {
    test.use(visitor(43))
    test('closing the sheet goes on to Discover, as Continue does', async ({ page, request }) => {
      const { sheet, visited } = await join(page, request, 'link', (route) =>
        route.fulfill({ status: 503, body: 'unavailable' }),
      )
      await expect(sheet.getByTestId('door-unsaved')).toBeVisible()
      await sheet.getByTestId('door-close').click()
      await expect(page).toHaveURL(/\/discover$/)
      await expect(sheet).toHaveCount(0)
      expect(visited).not.toContain('/reading')
    })
  })

  test.describe('slow', () => {
    test.use(visitor(42))
    test('the sheet stays until it is saved, then goes straight on to Discover', async ({
      page,
      request,
    }) => {
      const { sheet, visited } = await join(page, request, 'link', (route) => route.continue())
      await expect(page).toHaveURL(/\/discover$/)
      await expect(sheet).toHaveCount(0)
      expect(visited).not.toContain('/reading')
      await expect(page.getByTestId('account-menu')).toBeVisible()
    })
  })
})

test.describe('a member at /join', () => {
  /**
   * A tab with the member's cookie and nothing on the device does not know whom it holds until /me
   * answers, so `/join` opens the sheet meanwhile. The sheet did not sign them in: once /me names
   * them, they go where a member goes, not to the Discover a joiner the sheet signs in lands on.
   */
  test('with a code and no copy on the device, goes on to their reading', async ({ browser }) => {
    const context = await browser.newContext({ storageState: STATE_FILE })
    try {
      const page = await context.newPage()
      const visited: string[] = []
      page.on('framenavigated', (frame) => {
        if (frame === page.mainFrame()) visited.push(new URL(frame.url()).pathname)
      })
      let release = () => {}
      const held = new Promise<void>((resolve) => {
        release = resolve
      })
      await page.route('**/api/v1/me', async (route) => {
        await held
        await route.continue()
      })
      await page.goto('/join?code=E2EMEMBERCODE')
      const sheet = page.getByTestId('front-door')
      await expect(sheet.getByTestId('join-code')).toHaveValue('E2EMEMBERCODE')
      release()
      await expect(page).toHaveURL(/\/reading$/)
      await expect(sheet).toHaveCount(0)
      expect(visited).not.toContain('/discover')
    } finally {
      await context.close()
    }
  })
})

test.describe('a link with an invite code', () => {
  test.use(visitor(14))
  test('fills the code in and takes it out of the address bar; a used code is told so', async ({
    page,
    request,
  }) => {
    const code = await adminCode(request)
    await page.goto(`/join?code=${code}`)
    const sheet = page.getByTestId('front-door')
    await expect(sheet.getByTestId('join-code')).toHaveValue(code)
    await expect(page).toHaveURL(/\/join$/)
    await expect(sheet.getByTestId('login-email')).toBeFocused()

    // Someone else joins with it first, and it was for one person.
    const first = `first-${Date.now()}@e2e.test`
    const otp = await joinAndReadCode(request, code, first)
    const joined = await request.post(`${BASE}/api/auth/sign-in/email-otp`, {
      headers: ORIGIN,
      data: { email: first, otp },
    })
    expect(joined.ok()).toBe(true)

    await sheet.getByTestId('login-email').fill(`second-${Date.now()}@e2e.test`)
    await sheet.getByTestId('login-submit').click()
    await expect(sheet.getByTestId('door-error')).toHaveText(
      'Everyone this invite code was for has joined.',
    )
    // Closed, the sheet leaves `/join` for the front page.
    await sheet.getByTestId('door-close').click()
    await expect(page).toHaveURL(/\/$/)
    await expect(sheet).toHaveCount(0)
  })
})

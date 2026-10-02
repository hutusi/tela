/**
 * Signing in with an emailed code (ADR 0024), in a browser, from nothing: the code typed into the
 * form, and the mail's link opened on another device, which names the account and waits for a
 * press before it signs in (ADR 0036).
 */
import { type BrowserContext, expect, type Page, test } from '@playwright/test'
import {
  addFeed,
  BASE,
  cycle,
  FIXTURES,
  fromAccountMenu,
  inviteAndReadCode,
  latestCode,
  memberHeaders,
  signInRequest,
} from './helpers'

test.use({ storageState: { cookies: [], origins: [] } })

/**
 * Sign-in allows three tries a minute per address (better-auth, keyed on CF-Connecting-IP), and
 * the whole suite comes from 127.0.0.1. Each test is its own visitor; in production Cloudflare
 * sets the header itself.
 */
const visitor = (n: number) => ({ extraHTTPHeaders: { 'cf-connecting-ip': `198.51.100.${n}` } })

test.describe('by code', () => {
  test.use(visitor(1))
  test('a member signs in with the code from their mail, and a wrong code says so', async ({
    page,
    request,
  }) => {
    const email = `newcomer-${Date.now()}@e2e.test`
    await inviteAndReadCode(request, email)

    await page.goto('/reading')
    await expect(page).toHaveURL(/\/login\?next=%2Freading$/)
    await page.getByTestId('login-email').fill(email)
    await page.getByTestId('login-submit').click()
    await expect(page.getByTestId('login-code')).toBeVisible()

    await page.getByTestId('login-code').fill('000000')
    await page.getByTestId('login-submit').click()
    await expect(page.getByTestId('login-form')).toContainText('That code is wrong or has expired.')

    await page.getByTestId('login-code').fill(await latestCode(request, email))
    await page.getByTestId('login-submit').click()
    await expect(page).toHaveURL(/\/reading$/)
    // A new member follows nothing yet.
    await expect(page.getByTestId('empty-state')).toBeVisible()

    await fromAccountMenu(page, 'sign-out')
    await expect(page).toHaveURL(/\/$/)
    await page.goto('/reading')
    await expect(page).toHaveURL(/\/login/)
  })
})

test.describe('by link', () => {
  test.use(visitor(2))
  test("the mail's link signs in whichever browser opens it, once asked, and leaves no code in the address bar", async ({
    page,
    request,
  }) => {
    const email = `linked-${Date.now()}@e2e.test`
    const code = await inviteAndReadCode(request, email)
    await page.goto(`/login?email=${encodeURIComponent(email)}&otp=${code}&next=%2Fsettings`)

    // Found in review: a link that signed in on arrival was a login CSRF, since anyone could send
    // a link to their own code and put the reader in their account. It names the account and waits.
    await expect(page.getByTestId('login-link-as')).toHaveText(`Sign in as ${email}?`)
    await expect(page).toHaveURL(/\/login\?next=%2Fsettings$/)
    expect((await page.request.get('/api/v1/me')).status()).toBe(401)

    await page.getByTestId('login-submit').click()
    await expect(page).toHaveURL(/\/settings$/)
    await expect(page.getByTestId('settings-form')).toBeVisible()
    expect(page.url()).not.toContain('otp=')
  })

  test('declined, it leaves the reader signed out at the email form', async ({ page }) => {
    // Any code will do: declining sends nothing.
    await page.goto(`/login?email=${encodeURIComponent('someone@e2e.test')}&otp=123456`)
    await expect(page.getByTestId('login-link-as')).toBeVisible()
    await expect(page).toHaveURL(/\/login$/)
    await page.getByTestId('login-link-other').click()
    await expect(page.getByTestId('login-email')).toBeVisible()
    expect((await page.request.get('/api/v1/me')).status()).toBe(401)
  })
})

test.describe('by reset link', () => {
  test.use(visitor(30))
  test('asks for the new password, then signs in with it', async ({ page, request }) => {
    const email = `reset-${Date.now()}@e2e.test`
    await signInRequest(request, email)
    const asked = await request.post(`${BASE}/api/auth/email-otp/request-password-reset`, {
      headers: { origin: BASE },
      data: { email },
    })
    expect(asked.ok()).toBe(true)
    const code = await latestCode(request, email)

    await page.goto(`/login?reset=1&email=${encodeURIComponent(email)}&otp=${code}`)
    await expect(page.getByTestId('login-link-as')).toHaveText(
      `Choose a new password for ${email}.`,
    )
    await expect(page).toHaveURL(/\/login$/)
    const password = `correct horse ${Date.now()}`
    await page.getByTestId('login-new-password').fill(password)
    await page.getByTestId('login-submit').click()
    await expect(page).toHaveURL(/\/reading$/)

    // The password is the member's now, from any browser.
    const signedIn = await request.post(`${BASE}/api/auth/sign-in/email`, {
      headers: { origin: BASE },
      data: { email, password },
    })
    expect(signedIn.ok()).toBe(true)
  })
})

/**
 * One browser, two accounts: `page` signed in as the first, following a fixture feed, open at
 * `path`; then the second signed in (the cookie is the whole browser's) and open in another tab.
 * `page` is left in front, still showing the first account.
 */
async function twoAccounts(
  page: Page,
  context: BrowserContext,
  path: '/reading' | '/settings' = '/reading',
): Promise<{ other: Page }> {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  await signInRequest(context.request, `first-${stamp}@e2e.test`)
  await addFeed(context.request, `${FIXTURES}/jnito.xml`)
  await cycle(context.request)
  await page.goto('/reading')
  await expect(page.getByTestId('subscription')).toHaveCount(1)
  if (path === '/settings') {
    await page.goto('/settings')
    await expect(page.getByTestId('settings-form')).toBeVisible()
  }

  const other = await context.newPage()
  await signInRequest(context.request, `second-${stamp}@e2e.test`)
  await other.goto('/reading')
  await expect(other.getByTestId('empty-state')).toBeVisible()
  await showsSessionAccount(other, context)
  await page.bringToFront()
  return { other }
}

/**
 * The page shows the account the session is now, not only an empty pane: the header's account
 * menu names that account's own handle, which only its own synced rows can put there.
 */
async function showsSessionAccount(page: Page, context: BrowserContext): Promise<void> {
  const me = (await (await context.request.get('/api/v1/me')).json()) as {
    profile: { handle: string }
  }
  await expect(page.getByTestId('account-menu')).toHaveAttribute('data-handle', me.profile.handle)
}

/** A sync the page makes from now on, answered: only a tab holding the session's account gets one. */
const nextSync = (page: Page) =>
  page.waitForResponse((r) => new URL(r.url()).pathname === '/api/v1/sync' && r.ok())

test.describe('two accounts in one browser', () => {
  test.use(visitor(3))
  test('a tab still holding one account starts over when another tab signs in as someone else', async ({
    page,
    context,
  }) => {
    await twoAccounts(page, context)

    // The first tab still shows the first account. Opening a post reads it; the device will not
    // keep that change for the second account, and the tab starts over as them.
    const resynced = nextSync(page)
    await page.getByTestId('article-row').first().click()
    await expect(page.getByTestId('subscription')).toHaveCount(0)
    // Its first sync as the second account, and any push that would go with it, are done.
    await resynced
    await page.waitForLoadState('networkidle')

    // A check that could see the leak: once the second account follows the same feed, a
    // snapshot carries their read state for its posts. The one opened in the stale tab is unread.
    await addFeed(context.request, `${FIXTURES}/jnito.xml`)
    const pulled = await (
      await context.request.get('/api/v1/sync?cursor=0', {
        headers: await memberHeaders(context.request),
      })
    ).json()
    expect(pulled.rows.subscriptions).toHaveLength(1)
    expect(pulled.rows.states).toEqual([])
  })
})

test.describe('a stale tab saving settings', () => {
  test.use(visitor(4))
  test("changes nothing of the other account's, and starts over as them", async ({
    page,
    context,
  }) => {
    await twoAccounts(page, context, '/settings')
    const profileNow = async () =>
      ((await (await context.request.get('/api/v1/me')).json()) as { profile: unknown }).profile
    const before = await profileNow()

    await page.getByTestId('settings-handle').fill(`stale${Date.now().toString(36)}`)
    await page.getByTestId('settings-display-name').fill('Stale Tab')
    await page.getByTestId('settings-save').click()
    // Refused as a call for another account than the session's: the tab starts again from '/',
    // which sends the member signed in now to their reading.
    await expect(page).toHaveURL(/\/reading$/)
    await showsSessionAccount(page, context)
    expect(await profileNow()).toEqual(before)
  })
})

test.describe('a stale tab signing out', () => {
  test.use(visitor(5))
  test('leaves the other account signed in, and its tab still syncing', async ({
    page,
    context,
  }) => {
    const { other } = await twoAccounts(page, context)
    const resynced = nextSync(page)
    await fromAccountMenu(page, 'sign-out')
    // The session is the second account's: this tab forgets the first and starts over as the
    // second, rather than end a session that is not its own.
    await showsSessionAccount(page, context)
    expect((await context.request.get('/api/v1/me')).status()).toBe(200)
    await resynced

    const synced = nextSync(other)
    await other.reload()
    await synced
    await showsSessionAccount(other, context)
  })
})

test.describe('the mail link for another account, opened in a signed-in tab', () => {
  test.use(visitor(6))
  test('loads a fresh page, so nothing the first account held in memory carries over', async ({
    page,
    context,
    request,
  }) => {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    await signInRequest(context.request, `first-${stamp}@e2e.test`)
    await addFeed(context.request, `${FIXTURES}/jnito.xml`)
    await cycle(context.request)
    await page.goto('/reading')
    await expect(page.getByTestId('subscription')).toHaveCount(1)

    // The second account's link, followed inside the running app (a mail client handing the link
    // to this tab), so only the app itself can decide whether the page is loaded afresh.
    const second = `second-${stamp}@e2e.test`
    const code = await inviteAndReadCode(request, second)
    await page.evaluate(
      ({ email, otp }) => {
        ;(window as { stale?: number }).stale = 1
        history.pushState({}, '', `/login?email=${encodeURIComponent(email)}&otp=${otp}`)
        dispatchEvent(new PopStateEvent('popstate'))
      },
      { email: second, otp: code },
    )
    // A member's tab answers the link too: it may be for another account, which is how one switches.
    await expect(page.getByTestId('login-link-as')).toContainText(second)
    await page.getByTestId('login-submit').click()
    await expect(page).toHaveURL(/\/reading$/)
    await showsSessionAccount(page, context)
    await expect(page.getByTestId('subscription')).toHaveCount(0)
    expect(await page.evaluate(() => (window as { stale?: number }).stale)).toBeUndefined()
  })
})

/** The keys of this build's device copy that hold unsent changes. */
const pendingKeys = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<string[]>((resolve, reject) => {
        const open = indexedDB.open('tela-2')
        open.onerror = () => reject(open.error)
        open.onsuccess = () => {
          const db = open.result
          const keys = db.transaction('meta').objectStore('meta').getAllKeys()
          keys.onerror = () => reject(keys.error)
          keys.onsuccess = () => {
            db.close()
            resolve(keys.result.map(String).filter((k) => k.startsWith('pending:')))
          }
        }
      }),
  )

/** An earlier build's tab writes its own copy, as one left open across a deploy does. */
const earlierBuildWrites = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const open = indexedDB.open('tela', 1)
        open.onupgradeneeded = () => {
          for (const store of ['meta', 'tables', 'bodies', 'objects']) {
            open.result.createObjectStore(store)
          }
        }
        open.onerror = () => reject(open.error)
        open.onsuccess = () => {
          const db = open.result
          const tx = db.transaction('meta', 'readwrite')
          tx.objectStore('meta').put('someone-else', 'userId')
          tx.onerror = () => reject(tx.error)
          tx.oncomplete = () => {
            db.close()
            resolve()
          }
        }
      }),
  )

test.describe('a boot that cannot reach /me', () => {
  test.use(visitor(7))
  test('keeps the copy and its unsent change, and asks again until it can', async ({
    page,
    context,
  }) => {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    await signInRequest(context.request, `unreached-${stamp}@e2e.test`)
    await addFeed(context.request, `${FIXTURES}/jnito.xml`)
    await cycle(context.request)
    await page.goto('/reading')
    await expect(page.getByTestId('subscription')).toHaveCount(1)

    // A change the server has not had yet: every push is held back.
    await page.route('**/api/v1/mutations', (route) => route.abort())
    await page.getByTestId('article-row').first().click()
    await expect.poll(() => pendingKeys(page)).toHaveLength(1)

    // An earlier build ran since, so this boot asks /me before trusting the copy, and /me
    // answers as tela-api does mid-deploy, to the boot and to the first retry. That says
    // nothing about the session.
    await earlierBuildWrites(page)
    let asked = 0
    await page.route('**/api/v1/me', (route) =>
      ++asked <= 2 ? route.fulfill({ status: 503, body: 'deploying' }) : route.continue(),
    )
    await page.reload()
    await expect(page).toHaveURL(/\/login\?next=%2Freading/)
    expect(await pendingKeys(page)).toHaveLength(1)

    // tela-api is back. Nothing but the tab's own retries ask again, and the one after a second
    // miss carries on as the member, sending the change it kept.
    const pushed = page.waitForResponse(
      (r) => new URL(r.url()).pathname === '/api/v1/mutations' && r.ok(),
    )
    await page.unroute('**/api/v1/mutations')
    await expect(page).toHaveURL(/\/reading(\?|$)/, { timeout: 20_000 })
    expect(asked).toBe(3)
    await pushed
    const pulled = await (
      await context.request.get('/api/v1/sync?cursor=0', {
        headers: await memberHeaders(context.request),
      })
    ).json()
    expect(pulled.rows.states).toHaveLength(1)
  })
})

test.describe('the mail link while /me misses', () => {
  test.use(visitor(8))
  test('for another account, in a signed-in tab: a fresh page as them, once /me answers', async ({
    page,
    context,
    request,
  }) => {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    await signInRequest(context.request, `first-${stamp}@e2e.test`)
    await addFeed(context.request, `${FIXTURES}/jnito.xml`)
    await cycle(context.request)
    await page.goto('/reading')
    await expect(page.getByTestId('subscription')).toHaveCount(1)

    // The link signs in as the second account, and the /me after it misses once: the retry
    // is what learns who is signed in.
    let asked = 0
    await page.route('**/api/v1/me', (route) =>
      ++asked === 1 ? route.fulfill({ status: 503, body: 'deploying' }) : route.continue(),
    )
    const second = `second-${stamp}@e2e.test`
    const code = await inviteAndReadCode(request, second)
    await page.evaluate(
      ({ email, otp }) => {
        ;(window as { stale?: number }).stale = 1
        history.pushState({}, '', `/login?email=${encodeURIComponent(email)}&otp=${otp}`)
        dispatchEvent(new PopStateEvent('popstate'))
      },
      { email: second, otp: code },
    )
    // A member's tab answers the link too: it may be for another account, which is how one switches.
    await expect(page.getByTestId('login-link-as')).toContainText(second)
    await page.getByTestId('login-submit').click()
    // Found in review: the retry claimed the second account on the first account's page, with
    // no fresh page and no pull, so an empty reader showed until the next minute's sync.
    await expect(page).toHaveURL(/\/reading$/, { timeout: 15_000 })
    await showsSessionAccount(page, context)
    await expect(page.getByTestId('subscription')).toHaveCount(0)
    expect(await page.evaluate(() => (window as { stale?: number }).stale)).toBeUndefined()
    expect(asked).toBeGreaterThanOrEqual(2)
  })
})

test.describe('the mail link on a new device while /me misses', () => {
  test.use(visitor(9))
  test('says it is connecting, shows the public side meanwhile, and carries on', async ({
    page,
    request,
  }) => {
    const email = `connecting-${Date.now()}@e2e.test`
    const code = await inviteAndReadCode(request, email)
    // The boot's /me is held until the sign-in's own /me has missed, so the boot's answer comes
    // last and is dropped; after that /me misses until tela-api is back.
    let asked = 0
    let back = false
    let signInMissed = () => {}
    const missed = new Promise<void>((r) => {
      signInMissed = r
    })
    await page.route('**/api/v1/me', async (route) => {
      const n = ++asked
      if (n === 1) {
        await missed
        return route.continue()
      }
      if (n === 2) {
        await route.fulfill({ status: 503, body: 'deploying' })
        return signInMissed()
      }
      return back ? route.continue() : route.fulfill({ status: 503, body: 'deploying' })
    })
    const bootAnswered = page.waitForResponse(
      (r) => new URL(r.url()).pathname === '/api/v1/me' && r.status() !== 503,
    )
    await page.goto(`/login?email=${encodeURIComponent(email)}&otp=${code}&next=%2Fsettings`)
    await page.getByTestId('login-submit').click()

    // The code is spent: the form says why nothing moves, and cannot send it again.
    await expect(page.getByTestId('login-connecting')).toBeVisible()
    await expect(page.getByTestId('login-submit')).toBeDisabled()
    await bootAnswered

    // Found in review: with the boot's answer dropped, a miss left the tab 'unknown', where the
    // home page and the header render nothing. It is a guest meanwhile.
    await page.getByRole('link', { name: 'Tela' }).first().click()
    await expect(page).toHaveURL(/\/$/)
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(
      'Independent blogs, in any language.',
    )
    await expect(page.getByRole('banner').getByRole('link', { name: 'Sign in' })).toBeVisible()

    // A retry misses too before tela-api is back, and the one after it carries on.
    await expect.poll(() => asked, { timeout: 10_000 }).toBeGreaterThanOrEqual(3)
    back = true
    await expect(page).toHaveURL(/\/reading$/, { timeout: 20_000 })
  })
})

test.describe('the mail link while the device refuses the claim once', () => {
  test.use(visitor(10))
  test('for another account, in a signed-in tab: still a fresh page as them', async ({
    page,
    context,
    request,
  }) => {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    await signInRequest(context.request, `first-${stamp}@e2e.test`)
    await addFeed(context.request, `${FIXTURES}/jnito.xml`)
    await cycle(context.request)
    await page.goto('/reading')
    await expect(page.getByTestId('subscription')).toHaveCount(1)

    // Syncing is held, so the old account's engine cannot be refused and leave: only the way
    // the session settles the retry can load a fresh page.
    await page.route(
      (url) => url.pathname === '/api/v1/sync',
      () => {},
    )
    // The device refuses the next write over its whole copy, which is the claim.
    await page.evaluate(() => {
      const open = IDBDatabase.prototype.transaction
      let armed = true
      IDBDatabase.prototype.transaction = function (
        this: IDBDatabase,
        names: string | string[],
        mode?: IDBTransactionMode,
        options?: IDBTransactionOptions,
      ) {
        const tx = open.call(this, names, mode, options)
        if (armed && this.name === 'tela-2' && mode === 'readwrite' && names.length === 4) {
          armed = false
          sessionStorage.setItem('refused', '1')
          tx.abort()
        }
        return tx
      }
    })
    const second = `second-${stamp}@e2e.test`
    const code = await inviteAndReadCode(request, second)
    await page.evaluate(
      ({ email, otp }) => {
        ;(window as { stale?: number }).stale = 1
        history.pushState({}, '', `/login?email=${encodeURIComponent(email)}&otp=${otp}`)
        dispatchEvent(new PopStateEvent('popstate'))
      },
      { email: second, otp: code },
    )
    // A member's tab answers the link too: it may be for another account, which is how one switches.
    await expect(page.getByTestId('login-link-as')).toContainText(second)
    await page.getByTestId('login-submit').click()
    // Found in review: the refused claim had already moved the store to the second account, so
    // the retry's claim compared it with itself, and pulled instead of loading a fresh page.
    await expect
      .poll(() => page.evaluate(() => (window as { stale?: number }).stale), { timeout: 15_000 })
      .toBeUndefined()
    await expect(page).toHaveURL(/\/reading$/)
    expect(await page.evaluate(() => sessionStorage.getItem('refused'))).toBe('1')
  })
})

test.describe("a visitor's language", () => {
  test('is chosen on the sign-in page, not in the header', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByRole('banner').getByRole('link', { name: 'Sign in' })).toBeVisible()
    await expect(page.getByTestId('locale-switcher')).toHaveCount(0)
    await page.goto('/login')
    await page.getByTestId('locale-switcher').getByRole('button', { name: '中文' }).click()
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-Hans')
    // The choice is the cookie the edge reads, so a public page arrives in Chinese too.
    await page.goto('/discover')
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-Hans')
  })
})

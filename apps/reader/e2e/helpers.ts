/**
 * What the specs share: the stack's addresses, and sign-in through the real code flow (ADR 0024).
 * There is no dev-auth: a code is sent, read back from tela-api's test outbox, and entered.
 */
import { resolve } from 'node:path'
import { type APIRequestContext, type Page, request } from '@playwright/test'

export const BASE = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:8811'
export const FIXTURES = process.env.E2E_FIXTURE_URL ?? 'http://127.0.0.1:4790'
export const ADMIN_TOKEN = 'e2e-admin'
/** The member the global setup signs in, with two fixture feeds subscribed. */
export const READER = 'reader@e2e.test'
/** The member's cookies, which every spec starts from (run.sh sets it; the default is its path). */
export const STATE_FILE =
  process.env.E2E_STATE_FILE ?? resolve(process.cwd(), '../../.e2e-logs/reader/member.json')

/** A write through tela-web must come from its origin, as a browser's would. */
const ORIGIN = { origin: BASE }

/** Invite an address (creating the account once) and return the code the mail carries. */
export async function inviteAndReadCode(
  request: APIRequestContext,
  email: string,
): Promise<string> {
  const invited = await request.post(`${BASE}/api/admin/invite`, {
    headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    data: { email },
  })
  if (!invited.ok()) throw new Error(`invite failed: ${invited.status()} ${await invited.text()}`)
  return latestCode(request, email)
}

export async function latestCode(request: APIRequestContext, email: string): Promise<string> {
  const outbox = (await (
    await request.get(`${BASE}/api/test/outbox?email=${encodeURIComponent(email)}`)
  ).json()) as {
    subject: string
  }[]
  const code = outbox.at(-1)?.subject.match(/(\d{6})$/)?.[1]
  if (!code) throw new Error(`no code in the outbox for ${email}`)
  return code
}

/** Sign an API context in, the way the login page does. */
export async function signInRequest(request: APIRequestContext, email: string): Promise<void> {
  const otp = await inviteAndReadCode(request, email)
  const res = await request.post(`${BASE}/api/auth/sign-in/email-otp`, {
    headers: ORIGIN,
    data: { email, otp },
  })
  if (!res.ok()) throw new Error(`sign-in failed: ${res.status()} ${await res.text()}`)
}

/** Subscribe the signed-in context to a feed URL, as the add page does. */
export async function addFeed(
  request: APIRequestContext,
  feedUrl: string,
): Promise<{ feedId: number }> {
  const res = await request.post(`${BASE}/api/v1/feeds`, { headers: ORIGIN, data: { feedUrl } })
  if (!res.ok()) throw new Error(`add feed failed: ${res.status()} ${await res.text()}`)
  return (await res.json()) as { feedId: number }
}

/**
 * Run tela-jobs' sweeps until nothing is due: fetches, extraction, titles, bodies, claims. Local
 * dev fires no crons; production's minute tick does this.
 */
export async function cycle(
  request: APIRequestContext,
  options: { refetch?: boolean } = {},
): Promise<void> {
  const res = await request.post(`${BASE}/api/test/cycle${options.refetch ? '?refetch=1' : ''}`, {
    headers: ORIGIN,
  })
  if (!res.ok()) throw new Error(`cycle failed: ${res.status()} ${await res.text()}`)
}

/** Keep running the sweeps while a page waits on their work (a translation, a new feed). */
export function keepCycling(page: Page, everyMs = 1000): () => void {
  let stopped = false
  const loop = async () => {
    while (!stopped) {
      await cycle(page.request).catch(() => undefined)
      await new Promise((r) => setTimeout(r, everyMs))
    }
  }
  void loop()
  return () => {
    stopped = true
  }
}

/** Wait until the page's first sync has landed: the sidebar lists the subscriptions. */
export async function synced(page: Page): Promise<void> {
  await page.getByTestId('subscription').first().waitFor()
}

/**
 * Put the member's synced reading state back to its defaults: English, side by side, the default
 * text, line length and theme. Every spec signs in as the same member, and a spec's last change
 * is lost when its page closes before the push goes out, so a spec that depends on this state
 * resets it first instead of trusting the last spec to have put it back.
 */
export async function resetReading(api: APIRequestContext): Promise<void> {
  const at = Date.now()
  const change = (m: Record<string, unknown>) => ({ mid: crypto.randomUUID(), at, ...m })
  const res = await api.post(`${BASE}/api/v1/mutations`, {
    // x-tela-client carries MIN_CLIENT (packages/sync/src/protocol.ts), as the app's pushes do.
    headers: { ...ORIGIN, 'x-tela-client': '1' },
    data: {
      mutations: [
        change({ type: 'setProfile', readingLang: 'en' }),
        change({ type: 'setPref', key: 'reader.mode', value: 'side' }),
        change({ type: 'setPref', key: 'reader.size', value: 'm' }),
        change({ type: 'setPref', key: 'reader.measure', value: 'normal' }),
        change({ type: 'setPref', key: 'ui.theme', value: 'system' }),
      ],
    },
  })
  if (!res.ok()) throw new Error(`reset failed: ${res.status()} ${await res.text()}`)
}

/**
 * Make sure the member follows these fixture feeds and their posts are in, whatever ran before:
 * adding a feed Tela already has only subscribes to it.
 */
export async function ensureFeeds(paths: string[]): Promise<void> {
  const context = await request.newContext({ baseURL: BASE, storageState: STATE_FILE })
  try {
    for (const path of paths) await addFeed(context, `${FIXTURES}${path}`)
    await cycle(context)
  } finally {
    await context.dispose()
  }
}

/** Select `needle` inside the first leaf of a body column that contains it, as a reader's drag would. */
export async function selectText(
  page: Page,
  needle: string,
  column = 'body-original',
): Promise<void> {
  await page.evaluate(
    ({ needle, column }) => {
      const leaf = [...document.querySelectorAll(`[data-testid="${column}"] [data-tb]`)].find(
        (el) => el.textContent?.includes(needle),
      )
      if (!leaf) throw new Error(`no leaf holds ${needle}`)
      const start = (leaf.textContent ?? '').indexOf(needle)
      const walker = document.createTreeWalker(leaf, NodeFilter.SHOW_TEXT)
      const range = document.createRange()
      let at = 0
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const length = (node as Text).data.length
        if (start >= at && start < at + length) range.setStart(node, start - at)
        if (start + needle.length <= at + length) {
          range.setEnd(node, start + needle.length - at)
          break
        }
        at += length
      }
      const selection = window.getSelection()
      selection?.removeAllRanges()
      selection?.addRange(range)
    },
    { needle, column },
  )
}

/** The text of every highlight painted on the page (CSS Custom Highlight API). */
export const painted = (page: Page) =>
  page.evaluate(() => {
    const registry = (CSS as unknown as { highlights?: Map<string, Set<Range>> }).highlights
    return [
      ...(registry?.get('tela-highlight') ?? []),
      ...(registry?.get('tela-highlight-active') ?? []),
    ].map((range) => range.toString())
  })

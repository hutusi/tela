/**
 * What the specs share: the stack's addresses, and sign-in through the real code flow (ADR 0024).
 * There is no dev-auth: a code is sent, read back from tela-api's test outbox, and entered.
 */
import { resolve } from 'node:path'
import { deflateSync } from 'node:zlib'
import { type APIRequestContext, expect, type Page, request } from '@playwright/test'

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

/**
 * An operator's invite code with `uses` places (ADR 0034), as `bun run admin code` makes one: its
 * own text, never a member code's shape.
 */
export async function adminCode(request: APIRequestContext, uses = 1): Promise<string> {
  const code =
    `E2E${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`.toUpperCase()
  const made = await request.post(`${BASE}/api/admin/codes`, {
    headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    data: { code, uses },
  })
  if (!made.ok()) throw new Error(`code failed: ${made.status()} ${await made.text()}`)
  return code
}

/** Join with an invite code, as the sheet does, and return the sign-in code the mail carries. */
export async function joinAndReadCode(
  request: APIRequestContext,
  code: string,
  email: string,
): Promise<string> {
  const joined = await request.post(`${BASE}/api/v1/join`, {
    headers: ORIGIN,
    data: { code, email },
  })
  if (!joined.ok()) throw new Error(`join failed: ${joined.status()} ${await joined.text()}`)
  return latestCode(request, email)
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

/**
 * What the app sends on every member call: the protocol it speaks and the account it holds, which
 * tela-api must find to be the session's (409 `account_changed` otherwise). The account is asked
 * of `/api/v1/me` each time, since a spec may sign the same context in as someone else.
 */
export async function memberHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const me = await request.get(`${BASE}/api/v1/me`)
  if (!me.ok()) throw new Error(`who am I failed: ${me.status()} ${await me.text()}`)
  const { id } = (await me.json()) as { id: string }
  // x-tela-client carries MIN_CLIENT (packages/sync/src/protocol.ts), as the app's calls do.
  return { 'x-tela-client': '2', 'x-tela-member': id }
}

/** Subscribe the signed-in context to a feed URL, as the add page does. */
export async function addFeed(
  request: APIRequestContext,
  feedUrl: string,
): Promise<{ feedId: number }> {
  const res = await request.post(`${BASE}/api/v1/feeds`, {
    headers: { ...ORIGIN, ...(await memberHeaders(request)) },
    data: { feedUrl },
  })
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

/** Open the account menu under the avatar and choose one of its items (Tela v2). */
export async function fromAccountMenu(page: Page, item: string): Promise<void> {
  await page.getByTestId('account-menu').click()
  await page.getByTestId(item).click()
}

/** Wait until the page's first sync has landed: the sidebar lists the subscriptions. */
export async function synced(page: Page): Promise<void> {
  await page.getByTestId('subscription').first().waitFor()
}

/** Set synced prefs through the API, as the app's own pushes do. */
export async function setPrefs(
  api: APIRequestContext,
  prefs: Record<string, unknown>,
  profile: Record<string, unknown> | null = null,
): Promise<void> {
  const at = Date.now()
  const change = (m: Record<string, unknown>) => ({ mid: crypto.randomUUID(), at, ...m })
  const res = await api.post(`${BASE}/api/v1/mutations`, {
    headers: { ...ORIGIN, ...(await memberHeaders(api)) },
    data: {
      mutations: [
        ...(profile ? [change({ type: 'setProfile', ...profile })] : []),
        ...Object.entries(prefs).map(([key, value]) => change({ type: 'setPref', key, value })),
      ],
    },
  })
  if (!res.ok()) throw new Error(`prefs failed: ${res.status()} ${await res.text()}`)
}

/**
 * Put the member's synced reading state back to its defaults: English to read and to use Tela in,
 * side by side, the default text, line length and theme, posts read on opening, read posts listed,
 * translation on opening and nothing left untranslated. Every spec signs in as the same member, and a spec's last change
 * is lost when its page closes before the push goes out, so a spec that depends on this state
 * resets it first instead of trusting the last spec to have put it back.
 */
export async function resetReading(api: APIRequestContext): Promise<void> {
  await setPrefs(
    api,
    {
      'reader.mode': 'side',
      'reader.size': 'm',
      'reader.measure': 'normal',
      'ui.theme': 'system',
      'reader.mark_on_open': true,
      'reader.hide_read': false,
      'translate.auto': true,
      'translate.never': [],
    },
    { readingLang: 'en', uiLocale: 'en' },
  )
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

/**
 * Which of these posts the device holds the body of, or with `lang` the finished translation of
 * (a synced `done` or `partial` row whose object is stored), read from IndexedDB itself: a spec
 * that counts requests waits for what the device holds, not for time to pass.
 */
export async function heldOnDevice(page: Page, ids: number[], lang?: string): Promise<number[]> {
  return page.evaluate(
    ({ ids, lang }) =>
      new Promise<number[]>((resolve, reject) => {
        const open = indexedDB.open('tela-2')
        // Not created yet: never create it empty under the app.
        open.onupgradeneeded = () => open.transaction?.abort()
        open.onerror = () => resolve([])
        open.onsuccess = () => {
          const db = open.result
          const tx = db.transaction(['tables', 'bodies', 'objects'])
          const articles = tx.objectStore('tables').get('articles')
          const translations = tx.objectStore('tables').get('translations')
          const bodies = tx.objectStore('bodies').getAllKeys()
          const objects = tx.objectStore('objects').getAllKeys()
          tx.onerror = () => reject(tx.error)
          tx.oncomplete = () => {
            db.close()
            type Row = { id: number; contentKey: string | null }
            type Translation = {
              contentKey: string
              lang: string
              state: string
              objectKey: string | null
            }
            const keyOf = new Map(
              ((articles.result ?? []) as Row[]).map((a) => [a.id, a.contentKey]),
            )
            const finished = new Map(
              ((translations.result ?? []) as Translation[])
                .filter((t) => t.lang === lang && (t.state === 'done' || t.state === 'partial'))
                .map((t) => [t.contentKey, t.objectKey]),
            )
            const held = new Set((lang ? objects : bodies).result.map(String))
            resolve(
              ids.filter((id) => {
                const key = keyOf.get(id)
                if (!key) return false
                const wanted = lang ? finished.get(key) : key
                return typeof wanted === 'string' && held.has(wanted)
              }),
            )
          }
        }
      }),
    { ids, lang: lang ?? null },
  )
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(bytes: Buffer): number {
  let c = 0xffffffff
  for (const b of bytes) c = (CRC_TABLE[(c ^ b) & 255] ?? 0) ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

/** A real PNG, `width` × `height`, a gradient: a picture a browser decodes, to upload (ADR 0033). */
export function pngFile(width: number, height: number): Buffer {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8 // bit depth
  header[9] = 2 // truecolour
  const row = 1 + width * 3
  const pixels = Buffer.alloc(row * height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = y * row + 1 + x * 3
      pixels[at] = Math.round((x / width) * 255)
      pixels[at + 1] = Math.round((y / height) * 255)
      pixels[at + 2] = 128
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(pixels)),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

/**
 * The header at the page's width (DESIGN.md: the nav is the one control allowed to shrink): what
 * scrolls sideways, the nav's room against its first pill, and the box of each control named.
 */
export async function measureHeader(page: Page, controls: string[]) {
  return page.evaluate((ids) => {
    const doc = document.documentElement
    const nav = document.querySelector('header nav') as HTMLElement
    const pill = nav.querySelector('a') as HTMLElement
    const boxes = Object.fromEntries(
      ids.map((id) => {
        const el = document.querySelector(`header [data-testid="${id}"]`) as HTMLElement | null
        const box = el?.getBoundingClientRect()
        return [
          id,
          {
            width: Math.round(box?.width ?? 0),
            height: Math.round(box?.height ?? 0),
            right: box?.right ?? Number.POSITIVE_INFINITY,
          },
        ]
      }),
    )
    return {
      overflow: doc.scrollWidth - doc.clientWidth,
      client: nav.clientWidth,
      scroll: nav.scrollWidth,
      pill: Math.round(pill.getBoundingClientRect().width),
      viewport: doc.clientWidth,
      controls: boxes,
    }
  }, controls)
}

/**
 * What every header must hold at `width`. The page never scrolls sideways, and the nav is never
 * squeezed below one pill (a 4px nav was what `md` once rendered); from `sm` up it is not clipped
 * at all. Measured on macOS with the theme switch in: the member's pill row is 247px (Reading,
 * Discover, Following), and 640px, the tightest case, leaves it 35px to spare, where CI's Linux
 * Chromium sets text about 2% wider (an older 335px row measured 341px there), some 5px of it.
 * The visitor's row is 175px, with 91px to spare at 640. Below `sm` the member's nav scrolls:
 * 102px of it shows at 360.
 */
export function expectHeaderFits(m: Awaited<ReturnType<typeof measureHeader>>, width: number) {
  expect(m.overflow, 'horizontal overflow').toBeLessThanOrEqual(0)
  expect(m.client, 'nav narrower than a single pill').toBeGreaterThanOrEqual(m.pill)
  if (width >= 640) expect(m.client, 'nav is clipped').toBe(m.scroll)
  for (const [id, box] of Object.entries(m.controls)) {
    expect(box.right, `${id} off screen`).toBeLessThanOrEqual(m.viewport)
  }
}

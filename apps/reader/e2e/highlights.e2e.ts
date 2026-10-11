/**
 * Highlights and notes (ADR 0026): made from a selection, painted over the text without touching
 * the article's DOM, kept across reloads, found again when the post changes, and admitted to be
 * gone when the passage is. A new one takes in those it overlaps, a removal can be undone, and the
 * list follows the post (Tela v5).
 */
import { type APIRequestContext, expect, type Page, test } from '@playwright/test'
import {
  BASE,
  cycle,
  ensureFeeds,
  FIXTURES,
  memberHeaders,
  painted,
  resetReading,
  selectText,
  synced,
} from './helpers'

const PASSAGE = 'garden teaches patience'

test.describe.configure({ mode: 'serial' })

test.beforeAll(async ({ request }) => {
  await request.post(`${FIXTURES}/__changing?v=1`)
  await ensureFeeds(['/changing.xml'])
})

/**
 * The post as v3 has it, the passage gone, whatever ran before: a spec that reads v3 calls this
 * itself, so it passes run alone (`-g`) as well as after the spec that moves the post there. A
 * refetch of a post that has not changed adds no version, so calling it again changes nothing.
 */
async function atV3(request: APIRequestContext) {
  await request.post(`${FIXTURES}/__changing?v=3`)
  await cycle(request, { refetch: true })
}

async function openChanging(page: Page) {
  await page.goto('/reading')
  await synced(page)
  await page.getByTestId('subscription').filter({ hasText: 'Changing Fixture' }).click()
  await page.getByTestId('article-row').filter({ hasText: 'A post that changes' }).click()
  await expect(page.getByTestId('body-original').first()).toBeVisible()
}

type ServerHighlight = { id: string; quote: string; note: string | null }

/** The member's highlights as tela-api holds them, through a snapshot pull. */
async function onServer(request: APIRequestContext): Promise<ServerHighlight[]> {
  const res = await request.get(`${BASE}/api/v1/sync?cursor=0`, {
    headers: await memberHeaders(request),
  })
  if (!res.ok()) throw new Error(`sync failed: ${res.status()} ${await res.text()}`)
  const { rows } = (await res.json()) as { rows: { highlights: ServerHighlight[] } }
  return rows.highlights
}

/** Delete every highlight the member has, through the API: the specs below start from none. */
async function clearHighlights(request: APIRequestContext): Promise<void> {
  const held = await onServer(request)
  if (held.length === 0) return
  const at = Date.now()
  const res = await request.post(`${BASE}/api/v1/mutations`, {
    headers: { origin: BASE, ...(await memberHeaders(request)) },
    data: {
      mutations: held.map(({ id }) => ({
        mid: crypto.randomUUID(),
        at,
        type: 'deleteHighlight',
        id,
      })),
    },
  })
  if (!res.ok()) throw new Error(`clearing highlights failed: ${res.status()} ${await res.text()}`)
}

/** Highlight `passage` from the toolbar and write `note` on it. */
async function highlightWithNote(page: Page, passage: string, note: string): Promise<void> {
  await selectText(page, passage)
  await page.getByTestId('highlight-create-note').click()
  await page.getByTestId('highlight-note-text').fill(note)
  await page.getByTestId('highlight-note-save').click()
  await expect(page.getByTestId('highlight-note')).toHaveCount(0)
}

/** Where the selection is on the screen. */
const selectionBox = (page: Page) =>
  page.evaluate(() => {
    const rect = window.getSelection()?.getRangeAt(0).getBoundingClientRect()
    return rect ? { top: rect.top, bottom: rect.bottom, centre: rect.left + rect.width / 2 } : null
  })

// Every spec here reads in English, side by side, at the default size and theme.
test.beforeEach(async ({ page }) => {
  await resetReading(page.request)
})

test('a selection becomes a highlight with a note, and both survive a reload', async ({ page }) => {
  await openChanging(page)
  await selectText(page, PASSAGE)
  await page.getByTestId('highlight-create').click()
  await expect(page.getByTestId('highlight-item')).toHaveCount(1)
  await expect.poll(() => painted(page)).toEqual([PASSAGE])
  // Painted, not wrapped: the article's own markup is as it was.
  expect(await page.locator('.article-body mark').count()).toBe(0)

  // A click on the painted text opens its note.
  const box = await page.evaluate(() => {
    const range = [
      ...((CSS as unknown as { highlights: Map<string, Set<Range>> }).highlights.get(
        'tela-highlight',
      ) ?? []),
    ][0]
    const rect = range?.getBoundingClientRect()
    return rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null
  })
  expect(box).not.toBeNull()
  await page.mouse.click(box?.x ?? 0, box?.y ?? 0)
  await page.getByTestId('highlight-note-text').fill('The whole point of the post.')
  const saved = page.waitForResponse((r) => r.url().includes('/api/v1/mutations') && r.ok())
  await page.getByTestId('highlight-note-save').click()
  await expect(page.getByTestId('highlights')).toContainText('The whole point of the post.')
  await saved

  await page.reload()
  await expect(page.getByTestId('highlight-item')).toHaveCount(1)
  await expect(page.getByTestId('highlights')).toContainText('The whole point of the post.')
  await expect.poll(() => painted(page)).toEqual([PASSAGE])
})

test('when the post changes, the highlight is found again and written back to the new version', async ({
  page,
  request,
}) => {
  await request.post(`${FIXTURES}/__changing?v=2`)
  await cycle(request, { refetch: true })
  await openChanging(page)
  await expect(page.getByTestId('body-original').first()).toContainText('In short:')
  await expect(page.getByTestId('highlight-item')).toHaveAttribute('data-status', 'shown')
  await expect.poll(() => painted(page)).toEqual([PASSAGE])

  // Every device will find it where this one did: the stored anchor now names the new version.
  const headers = await memberHeaders(request)
  await expect
    .poll(async () => {
      const sync = (await (
        await request.get(`${BASE}/api/v1/sync?cursor=0`, { headers })
      ).json()) as {
        rows: {
          articles: { id: number; contentKey: string }[]
          highlights: { articleId: number; contentKey: string }[]
        }
      }
      const h = sync.rows.highlights[0]
      return h
        ? sync.rows.articles.find((a) => a.id === h.articleId)?.contentKey === h.contentKey
        : false
    })
    .toBe(true)
})

test('a passage the post no longer has is kept with its note, and says so', async ({
  page,
  request,
}) => {
  await atV3(request)
  await openChanging(page)
  await expect(page.getByTestId('body-original').first()).toContainText('Something else entirely')
  const item = page.getByTestId('highlight-item')
  await expect(item).toHaveAttribute('data-status', 'detached')
  await expect(item).toContainText(PASSAGE)
  await expect(item).toContainText('The whole point of the post.')
  expect(await painted(page)).toEqual([])
  await item.getByRole('button', { name: 'Remove highlight' }).click()
  await expect(page.getByTestId('highlights')).toHaveCount(0)
})

test('a highlight on the translation belongs to that side and that language', async ({ page }) => {
  await ensureFeeds(['/jnito.xml'])
  await page.goto('/reading')
  await synced(page)
  await page.getByTestId('article-row').filter({ hasText: 'JA → EN' }).first().click()
  await expect(page.getByTestId('translation-bar')).toHaveAttribute('data-state', /done|partial/, {
    timeout: 30_000,
  })
  const text =
    (await page.getByTestId('body-translated').locator('[data-tb]').first().textContent()) ?? ''
  const needle = text.trim().slice(0, 12)
  await selectText(page, needle, 'body-translated')
  await page.getByTestId('highlight-create').click()
  await expect.poll(() => painted(page)).toEqual([needle])

  // The original alone does not show the translation: the highlight waits for it.
  await page.getByTestId('mode-orig').click()
  await expect(page.getByTestId('highlight-item')).toHaveAttribute('data-status', 'elsewhere')
  expect(await painted(page)).toEqual([])
  await page.getByTestId('mode-side').click()
  await expect.poll(() => painted(page)).toEqual([needle])
})

// The specs below read the post at v3 (`atV3`), and those that make highlights start from none.
const V3_FIRST = 'The first paragraph sets the scene.'

test('the toolbar sits over the selection with its key, and under it on a narrow screen', async ({
  page,
  request,
}) => {
  await atV3(request)
  await openChanging(page)
  await expect(page.getByTestId('body-original').first()).toContainText(V3_FIRST)
  await selectText(page, 'Something else entirely')
  const toolbar = page.getByTestId('highlight-toolbar')
  await expect(toolbar.locator('kbd')).toHaveText('H')
  // The key cap is shown, not read: the button is named by its label, and says its key apart.
  const create = page.getByTestId('highlight-create')
  await expect(create).toHaveAccessibleName('Highlight')
  await expect(create).toHaveAttribute('aria-keyshortcuts', 'h')
  await expect(toolbar).toHaveAttribute('data-place', 'above')
  // Centred 8px above the selection.
  const selected = await selectionBox(page)
  const box = await toolbar.boundingBox()
  expect(selected && box).toBeTruthy()
  if (!selected || !box) return
  expect(Math.abs(box.y + box.height - (selected.top - 8))).toBeLessThan(1.5)
  expect(Math.abs(box.x + box.width / 2 - selected.centre)).toBeLessThan(1.5)

  // Below `lg` it goes under the selection, clear of a phone's own selection menu, with buttons
  // a finger can hit.
  await page.setViewportSize({ width: 412, height: 860 })
  await selectText(page, 'Something else entirely')
  await expect(toolbar).toHaveAttribute('data-place', 'under')
  const narrow = await selectionBox(page)
  const under = await toolbar.boundingBox()
  expect(narrow && under).toBeTruthy()
  if (!narrow || !under) return
  expect(Math.abs(under.y - (narrow.bottom + 8))).toBeLessThan(1.5)
  expect((await page.getByTestId('highlight-create').boundingBox())?.height).toBeGreaterThanOrEqual(
    40,
  )
})

test('on a phone, a note with no room above the bottom bar opens over its highlight', async ({
  page,
  request,
}) => {
  const PASSAGE_V3 = 'Something else entirely'
  await atV3(request)
  await clearHighlights(request)
  // Opened at the desktop width, whose sidebar `openChanging` clicks, then narrowed to a phone.
  await openChanging(page)
  await page.setViewportSize({ width: 412, height: 560 })
  await expect(page.getByTestId('body-original').first()).toContainText(V3_FIRST)
  await selectText(page, PASSAGE_V3)
  await page.getByTestId('highlight-create').click()
  await expect.poll(() => painted(page)).toEqual([PASSAGE_V3])

  // The passage scrolled to 230px above the bar: a note under it (250px, 14px down) would fit in
  // the window, which is all the note used to ask, but end under the bar.
  const bar = await page.getByTestId('bottom-bar').boundingBox()
  expect(bar).not.toBeNull()
  const top = bar?.y ?? 0
  const at = await page.evaluate((y) => {
    const range = [
      ...((CSS as unknown as { highlights: Map<string, Set<Range>> }).highlights.get(
        'tela-highlight',
      ) ?? []),
    ][0]
    if (!range) return null
    window.scrollBy(0, range.getBoundingClientRect().top - y)
    const rect = range.getBoundingClientRect()
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
  }, top - 230)
  expect(at).not.toBeNull()
  if (!at) return
  const under = at.y + 14 + 250
  expect(under, 'a note under the passage would reach under the bar').toBeGreaterThan(top)
  expect(under, 'a note under the passage would fit in the window').toBeLessThanOrEqual(560)
  await page.mouse.click(at.x, at.y)
  const note = page.getByTestId('highlight-note')
  await expect(note).toBeVisible()
  const box = await note.boundingBox()
  expect(box && box.y + box.height, 'the note ends under the bar').toBeLessThanOrEqual(top)
  expect(box && box.y + box.height, 'the note is not over the passage').toBeLessThanOrEqual(at.y)
  await page.keyboard.press('Escape')
  await expect(note).toHaveCount(0)
})

test('the list follows the post, not the order the highlights were made in', async ({
  page,
  request,
}) => {
  await atV3(request)
  await clearHighlights(request)
  await openChanging(page)
  await expect(page.getByTestId('body-original').first()).toContainText(V3_FIRST)
  const items = page.getByTestId('highlight-item')
  // The last paragraph first, then the one before it.
  for (const [n, passage] of ['says goodbye', 'Something else'].entries()) {
    await selectText(page, passage)
    await page.getByTestId('highlight-create').click()
    await expect(items).toHaveCount(n + 1)
  }
  await expect(items.nth(0)).toContainText('Something else')
  await expect(items.nth(1)).toContainText('says goodbye')
  await expect(page.getByTestId('highlights')).toContainText(
    'Highlights and notes are private. Select text and press H to highlight.',
  )
})

test('a highlight over two others takes both in, and their notes join', async ({
  page,
  request,
}) => {
  const UNION = 'The first paragraph sets the scene'
  await atV3(request)
  await clearHighlights(request)
  await openChanging(page)
  await expect(page.getByTestId('body-original').first()).toContainText(V3_FIRST)
  // A space apart, two stay two.
  await highlightWithNote(page, 'The first paragraph', 'Opening.')
  await highlightWithNote(page, 'sets the scene', 'Scene.')
  const items = page.getByTestId('highlight-item')
  await expect(items).toHaveCount(2)
  await expect
    .poll(async () => (await painted(page)).sort())
    .toEqual(['The first paragraph', 'sets the scene'])

  // A selection across both makes one highlight of all of it, in one push.
  const merged = page.waitForRequest(
    (r) =>
      r.url().includes('/api/v1/mutations') && (r.postData() ?? '').includes('deleteHighlight'),
  )
  await selectText(page, 'paragraph sets')
  await page.getByTestId('highlight-create').click()
  await expect(items).toHaveCount(1)
  await expect.poll(() => painted(page)).toEqual([UNION])
  await expect(items).toContainText('Opening.')
  await expect(items).toContainText('Scene.')
  const { mutations } = JSON.parse((await merged).postData() ?? '{}') as {
    mutations: { type: string; quote?: string }[]
  }
  expect(mutations.filter((m) => m.type === 'deleteHighlight')).toHaveLength(2)
  expect(mutations.some((m) => m.type === 'putHighlight' && m.quote === UNION)).toBe(true)
  await expect
    .poll(async () => (await onServer(request)).map(({ quote, note }) => ({ quote, note })))
    .toEqual([{ quote: UNION, note: 'Opening.\n\nScene.' }])

  // Inside it already, a selection makes nothing, and Add a note opens the one it is in.
  await selectText(page, 'first paragraph')
  await page.getByTestId('highlight-create-note').click()
  await expect(page.getByTestId('highlight-note-text')).toHaveValue('Opening.\n\nScene.')
  await page.keyboard.press('Escape')
  await expect(items).toHaveCount(1)

  await page.reload()
  await expect(items).toHaveCount(1)
  await expect.poll(() => painted(page)).toEqual([UNION])
})

test('a removed highlight comes back with Undo, under the same id', async ({ page, request }) => {
  await atV3(request)
  await clearHighlights(request)
  // The toast's time is the page's clock, run on below rather than waited out.
  await page.clock.install()
  await openChanging(page)
  await expect(page.getByTestId('body-original').first()).toContainText(V3_FIRST)
  const pushed: string[] = []
  page.on('request', (r) => {
    if (r.url().includes('/api/v1/mutations')) pushed.push(r.postData() ?? '')
  })
  await selectText(page, 'Something else entirely')
  const saved = page.waitForResponse((r) => r.url().includes('/api/v1/mutations') && r.ok())
  await page.getByTestId('highlight-create').click()
  await saved
  await expect.poll(async () => (await onServer(request)).length).toBe(1)
  const [made] = await onServer(request)

  await page.getByTestId('highlight-item').getByRole('button').first().click()
  await page.getByTestId('highlight-remove').click()
  await expect(page.getByTestId('highlights')).toHaveCount(0)
  expect(await painted(page)).toEqual([])
  await expect(page.getByTestId('toast')).toContainText('Highlight removed.')
  await page.getByTestId('toast-action').click()
  await expect(page.getByTestId('highlight-item')).toHaveCount(1)
  await expect.poll(() => painted(page)).toEqual(['Something else entirely'])

  await page.reload()
  await expect(page.getByTestId('highlight-item')).toHaveCount(1)
  await expect.poll(() => painted(page)).toEqual(['Something else entirely'])
  // Taken back while it was held on the device: tela-api never heard of the removal.
  expect(pushed.some((body) => body.includes('deleteHighlight'))).toBe(false)
  expect((await onServer(request)).map(({ id }) => id)).toEqual([made?.id])

  // Left alone, a removal is held while its toast shows, and goes once the toast has.
  await page.getByTestId('highlight-item').getByRole('button').first().click()
  await page.getByTestId('highlight-remove').click()
  const toast = page.getByTestId('toast')
  await expect(toast).toContainText('Highlight removed.')
  // Nowhere near the toast, whose time a pointer over it would stop.
  await page.mouse.move(0, 0)
  await page.clock.runFor(3000)
  await expect(toast).toBeVisible()
  expect(pushed.some((body) => body.includes('deleteHighlight'))).toBe(false)
  await page.clock.runFor(3000)
  await expect(toast).toHaveCount(0)
  await expect.poll(async () => (await onServer(request)).length).toBe(0)
  expect(pushed.filter((body) => body.includes('deleteHighlight'))).toHaveLength(1)
})

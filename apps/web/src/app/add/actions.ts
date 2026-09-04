'use server'

import { consumeRateLimit, subscribe } from '@tela/db/queries'
import {
  createHttpClient,
  type DiscoveredFeed,
  discoverFeeds,
  ensureFeed,
  HttpError,
} from '@tela/ingest'
import { parseOpml } from 'feedsmith'
import { redirect } from 'next/navigation'
import { requireUser } from '@/lib/auth'
import { getDb } from '@/lib/platform/db'
import { enqueueFeedFetch } from '@/lib/queue'

export type DiscoverState = {
  candidates: DiscoveredFeed[] | null
  error: string | null
  query: string
}
export type ImportState = { imported: number | null; error: string | null }

const http = createHttpClient({
  userAgent: 'Tela/0.1 (+https://tela.app/bot; feed reader)',
  timeoutMs: 10_000,
  politenessMs: 0,
  // Tests point discovery at a fixture server on localhost; never set in production.
  allowPrivateHosts: process.env.TELA_ALLOW_PRIVATE_HOSTS === '1',
})

/** Accepts "example.blog", "https://example.blog/feed", and IP hosts; rejects prose. */
function looksLikeUrl(input: string): boolean {
  if (!input || /\s/.test(input)) return false
  try {
    const u = new URL(/^https?:\/\//i.test(input) ? input : `https://${input}`)
    return u.hostname.includes('.') || u.hostname === 'localhost'
  } catch {
    return false
  }
}

export async function discoverAction(_prev: DiscoverState, form: FormData): Promise<DiscoverState> {
  const user = await requireUser('/add')
  const query = String(form.get('url') ?? '').trim()
  if (!looksLikeUrl(query)) return { candidates: null, error: 'invalid_url', query }
  const limit = await consumeRateLimit(await getDb(), 'discover', user.id)
  if (!limit.allowed) return { candidates: null, error: 'rate_limited', query }
  try {
    const candidates = await discoverFeeds(http, query)
    return { candidates, error: null, query }
  } catch (err) {
    if (err instanceof HttpError) return { candidates: null, error: 'fetch_failed', query }
    throw err
  }
}

export async function subscribeAction(form: FormData): Promise<void> {
  const user = await requireUser('/add')
  const feedUrl = String(form.get('feedUrl') ?? '')
  if (!/^https?:\/\//.test(feedUrl)) redirect('/add')
  const db = await getDb()
  if (!(await consumeRateLimit(db, 'subscribe', user.id)).allowed)
    redirect('/add?error=rate_limited')
  const { feedId } = await ensureFeed(db, { feedUrl })
  await subscribe(db, user.id, feedId)
  await enqueueFeedFetch(db, feedId)
  redirect(`/reading?feed=${feedId}`)
}

type Outline = { xmlUrl?: string; outlines?: Outline[] }

function collectFeedUrls(outlines: Outline[] | undefined, out: string[]) {
  for (const o of outlines ?? []) {
    if (o.xmlUrl && /^https?:\/\//.test(o.xmlUrl)) out.push(o.xmlUrl)
    collectFeedUrls(o.outlines, out)
  }
}

export async function importOpmlAction(_prev: ImportState, form: FormData): Promise<ImportState> {
  const user = await requireUser('/add')
  const file = form.get('opml')
  if (!(file instanceof File)) return { imported: null, error: 'opml_invalid' }
  let urls: string[] = []
  try {
    const doc = parseOpml(await file.text()) as { body?: { outlines?: Outline[] } }
    collectFeedUrls(doc.body?.outlines, urls)
  } catch {
    return { imported: null, error: 'opml_invalid' }
  }
  urls = [...new Set(urls)].slice(0, 500)
  const db = await getDb()
  if (!(await consumeRateLimit(db, 'opmlImport', user.id)).allowed) {
    return { imported: null, error: 'rate_limited' }
  }
  let imported = 0
  for (const feedUrl of urls) {
    const { feedId } = await ensureFeed(db, { feedUrl })
    const { created } = await subscribe(db, user.id, feedId)
    if (created) imported += 1
  }
  return { imported, error: null }
}

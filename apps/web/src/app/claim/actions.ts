'use server'

import { createHttpClient, discoverFeeds, ensureFeed, HttpError } from '@tela/ingest'
import { redirect } from 'next/navigation'
import { requireUser } from '@/lib/auth'
import { getDb } from '@/lib/platform/db'

export type ClaimStartState = { error: string | null; query: string }

const http = createHttpClient({
  userAgent: 'Tela/0.1 (+https://tela.app/bot; feed reader)',
  timeoutMs: 10_000,
  politenessMs: 0,
  allowPrivateHosts: process.env.TELA_ALLOW_PRIVATE_HOSTS === '1',
})

function looksLikeUrl(input: string): boolean {
  if (!input || /\s/.test(input)) return false
  try {
    const u = new URL(/^https?:\/\//i.test(input) ? input : `https://${input}`)
    return u.hostname.includes('.') || u.hostname === 'localhost'
  } catch {
    return false
  }
}

/** Find the blog's feed, make sure its site exists, and continue to the verification page. */
export async function startClaimAction(
  _prev: ClaimStartState,
  form: FormData,
): Promise<ClaimStartState> {
  await requireUser('/claim')
  const query = String(form.get('url') ?? '').trim()
  if (!looksLikeUrl(query)) return { error: 'invalid_url', query }
  let found: Awaited<ReturnType<typeof discoverFeeds>>
  try {
    found = await discoverFeeds(http, query, { maxCandidates: 3 })
  } catch (err) {
    if (err instanceof HttpError) return { error: 'fetch_failed', query }
    throw err
  }
  const first = found[0]
  if (!first) return { error: 'no_feed', query }
  const { siteId } = await ensureFeed(await getDb(), { feedUrl: first.url })
  redirect(`/sites/${siteId}/claim`)
}

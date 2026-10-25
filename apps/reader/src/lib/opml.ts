/**
 * Subscriptions in and out as OPML, and saving a member's file. Both are RPCs: the member needs
 * the answer, and a download has to name the member, which a plain link cannot.
 */
import { api, apiJson } from '../store/api'

export type AddError =
  | 'invalid_url'
  | 'fetch_failed'
  | 'rate_limited'
  | 'opml_invalid'
  | 'opml_too_large'
  | 'feed_too_large'
  | 'feed_limit'
  | 'subscription_limit'

/** tela-api's answer, as the message a page has for it. */
export function addError(code: string | undefined): AddError {
  if (
    code === 'invalid_url' ||
    code === 'rate_limited' ||
    code === 'opml_invalid' ||
    code === 'opml_too_large' ||
    code === 'feed_too_large' ||
    code === 'feed_limit' ||
    code === 'subscription_limit'
  )
    return code
  return 'fetch_failed'
}

/**
 * Why an add was refused, with what a member's limit says (ADR 0063): `feed_limit` names the day's
 * allowance and when it comes back, `subscription_limit` the cap.
 */
export type AddProblem = { error: AddError; limit?: number; resetsAt?: number }

/** A refusal's body as the page words it. */
export function addProblem(body: unknown): AddProblem {
  const b = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {}
  return {
    error: addError(typeof b.error === 'string' ? b.error : undefined),
    ...(typeof b.limit === 'number' ? { limit: b.limit } : {}),
    ...(typeof b.resetsAt === 'number' ? { resetsAt: b.resetsAt } : {}),
  }
}

/**
 * What an import did (ADR 0063): `feeds`, the file's blogs the member now follows; the rest say
 * how many were new to Tela and added, how many wait for a later day and at how many a day, and
 * how many were left out past the subscription cap. A tela-api from before it sends `feeds` alone.
 */
export type Imported = {
  feeds: number
  added?: number
  waiting?: number
  over?: number
  perDay?: number | null
  maxSubscriptions?: number | null
}

const countOf = (v: unknown) => (typeof v === 'number' ? v : undefined)
const limitOf = (v: unknown) => (v === null || typeof v === 'number' ? v : undefined)

/** An import's answer: the fields it carries, and no others. */
export function readImported(body: unknown): Imported | null {
  const b = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {}
  const feeds = countOf(b.feeds)
  if (feeds === undefined) return null
  const imported: Imported = { feeds }
  const added = countOf(b.added)
  const waiting = countOf(b.waiting)
  const over = countOf(b.over)
  const perDay = limitOf(b.perDay)
  const maxSubscriptions = limitOf(b.maxSubscriptions)
  if (added !== undefined) imported.added = added
  if (waiting !== undefined) imported.waiting = waiting
  if (over !== undefined) imported.over = over
  if (perDay !== undefined) imported.perDay = perDay
  if (maxSubscriptions !== undefined) imported.maxSubscriptions = maxSubscriptions
  return imported
}

/** Import an OPML file: what it did, or why not. */
export async function importOpml(file: File): Promise<Imported | AddProblem> {
  if (file.size > 1024 * 1024) return { error: 'opml_too_large' }
  try {
    const { status, body } = await apiJson<unknown>('/api/v1/feeds/opml', {
      method: 'POST',
      raw: await file.text(),
    })
    return (status === 200 ? readImported(body) : null) ?? addProblem(body)
  } catch {
    return { error: 'fetch_failed' }
  }
}

/**
 * Fetch one of the member's files and save it. Through `api()` rather than a link: a navigation
 * cannot name the member, and a tab still holding one account must not save the file of whoever
 * the session belongs to now. False when there was nothing to save.
 */
export async function saveDownload(path: string, fallbackName: string): Promise<boolean> {
  try {
    const res = await api(path)
    if (!res.ok) return false
    const name =
      /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? fallbackName
    const url = URL.createObjectURL(await res.blob())
    const a = document.createElement('a')
    a.href = url
    a.download = name
    document.body.appendChild(a)
    a.click()
    a.remove()
    // Some browsers read the blob after click() returns.
    setTimeout(() => URL.revokeObjectURL(url), 60_000)
    return true
  } catch {
    // Offline, or the tab is leaving (api() has said so already): there is nothing to save.
    return false
  }
}
